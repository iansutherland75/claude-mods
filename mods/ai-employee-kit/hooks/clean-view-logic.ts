// Clean View's rules, with no engine calls, so the tests can call them.

import type { CleanViewChecklist, CleanViewPhase, CleanViewTask } from '../types'

export const PLUGIN = 'ai-employee-kit'
export const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
export const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`

// ---------------------------------------------------------------- names

const CODE_FILE =
  /\b[\w.-]+\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|ps1|json|jsonl|ya?ml|toml|ini|css|scss|less|html?|vue|svelte|sql|md|mdx|lock|env|xml|gradle|plist)\b/gi

export const NAME_LIMIT = 40

// Every step and job name goes through here: no code, no paths, no code file
// names, one line, a capital first letter, 40 characters at most.
export const cleanName = (raw: string): string => {
  let text = String(raw ?? '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .split(/\s+/)
    .filter(word => !word.includes('/') && !word.includes('\\'))
    .join(' ')
    .replace(CODE_FILE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return 'Working on it'
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (text.length <= NAME_LIMIT) return text

  const room = NAME_LIMIT - 1
  const cut = text.slice(0, room + 1)
  const space = cut.lastIndexOf(' ')
  const kept = (space > 8 ? cut.slice(0, space) : text.slice(0, room)).replace(/[\s,.;:–-]+$/, '')

  return `${kept}…`
}

// A first name for a job from the prompt itself, until Haiku names it.
export const titleFromPrompt = (text: string): string => {
  const first = text.replace(/\s+/g, ' ').trim().split(/(?<=[.?!])\s|[\n;:]/)[0] ?? ''
  const words = first.split(' ').filter(Boolean).slice(0, 6).join(' ')

  return cleanName(words.replace(/[.?!,]+$/, ''))
}

export const NAME_SYSTEM = [
  'Name the job a person just asked an AI assistant to do.',
  'Reply with 2 to 6 plain English words that start with a verb, like "Build the pricing page" or "Answer a question about invoices".',
  'No file names, code, quotes or punctuation. Reply with the name only.',
].join('\n')

export const namePrompt = (text: string): string => `The request:\n<request>\n${text.slice(0, 2000)}\n</request>`

// Haiku's reply as a job name, or null when it is not usable.
export const readJobName = (reply: string): string | null => {
  const line = (reply.split('\n').find(one => one.trim() !== '') ?? '').replace(/["'“”‘’*_.]/g, '').trim()
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 8) return null

  return cleanName(words.slice(0, 6).join(' '))
}

// ---------------------------------------------------------------- jobs and steps

export const PLACEHOLDERS = ['Understand your request', 'Plan the steps'] as const

export const newJob = (jobId: number, title: string, now: number): CleanViewChecklist => ({
  jobId,
  title,
  phase: 'working',
  tasks: PLACEHOLDERS.map((name, i) => ({
    id: `p${i}`,
    name,
    status: i === 0 ? 'active' : 'upcoming',
    percent: 0,
    hasReported: false,
  })),
  source: 'placeholder',
  needsYouReason: null,
  stuckReason: null,
  startedAt: now,
  finishedAt: null,
  isCollapsed: false,
})

// Whether a real plan exists: Claude's own steps or its to-do list.
export const hasPlan = (list: CleanViewChecklist | null): boolean => list !== null && list.source !== 'placeholder'

const task = (id: string, name: string, status: CleanViewTask['status']): CleanViewTask => ({
  id,
  name,
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: status === 'done',
})

// Back to Working: progress means Claude is moving again.
const moving = (list: CleanViewChecklist): CleanViewChecklist =>
  list.phase === 'needsYou' || list.phase === 'stuck'
    ? { ...list, phase: 'working', needsYouReason: null, stuckReason: null }
    : list

// plan_steps: 2 to 8 steps in order, the first one started.
export const applyPlan = (list: CleanViewChecklist, steps: readonly unknown[]): { list: CleanViewChecklist; count: number } => {
  const names = steps
    .filter((step): step is string => typeof step === 'string' && step.trim() !== '')
    .map(cleanName)
    .slice(0, 8)
  if (names.length === 0) return { list, count: 0 }

  return {
    list: moving({
      ...list,
      source: 'plan',
      tasks: names.map((name, i) => task(`s${list.jobId}-${i}`, name, i === 0 ? 'active' : 'upcoming')),
    }),
    count: names.length,
  }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// report_progress: everything before the named step is done; at 100 it is done
// and the next one starts; a name not in the plan becomes a new step.
export const applyProgress = (list: CleanViewChecklist, rawName: string, rawPercent: unknown): { list: CleanViewChecklist; percent: number } => {
  const number = typeof rawPercent === 'number' ? rawPercent : Number(rawPercent)
  const percent = Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0
  const name = cleanName(rawName)
  let tasks = list.source === 'placeholder' ? [] : [...list.tasks]
  let index = tasks.findIndex(one => sameName(one.name, name))
  if (index < 0) {
    tasks = [...tasks, task(`r${list.jobId}-${tasks.length}`, name, 'upcoming')]
    index = tasks.length - 1
  }
  let startNext = false
  tasks = tasks.map((one, i) => {
    if (i < index) return { ...one, status: 'done', percent: 100, hasReported: true }
    if (i === index) {
      if (percent >= 100) {
        startNext = true

        return { ...one, status: 'done', percent: 100, hasReported: true }
      }

      return { ...one, status: 'active', percent, hasReported: true }
    }

    return one.status === 'active' ? { ...one, status: 'upcoming' } : one
  })
  if (startNext) {
    const next = tasks.findIndex((one, i) => i > index && one.status === 'upcoming')
    if (next >= 0) tasks[next] = { ...tasks[next]!, status: 'active' }
  }

  return { list: moving({ ...list, source: list.source === 'placeholder' ? 'plan' : list.source, tasks }), percent }
}

export type ListItem = { name: string; status: string }

const STATUS: Record<string, CleanViewTask['status']> = {
  completed: 'done',
  in_progress: 'active',
  pending: 'upcoming',
}

// A whole to-do list (TodoWrite, or the desktop task list's items): its rows
// become the checklist; an active step keeps the percent it reported.
export const applyList = (list: CleanViewChecklist, items: readonly ListItem[]): CleanViewChecklist => {
  const rows = items.filter(item => typeof item.name === 'string' && item.name.trim() !== '')
  if (rows.length === 0) return list
  const tasks = rows.map((item, i) => {
    const name = cleanName(item.name)
    const status = STATUS[item.status] ?? 'upcoming'
    const before = list.tasks.find(one => sameName(one.name, name))
    const kept = status === 'active' && before?.status === 'active' && before.hasReported

    return {
      id: `l${list.jobId}-${i}`,
      name,
      status,
      percent: status === 'done' ? 100 : kept ? before.percent : 0,
      hasReported: status === 'done' || kept,
    }
  })

  return moving({ ...list, source: 'list', tasks })
}

// The desktop task list's small updates: advance one step, or mark some done
// and start another (numbers count from 1).
export const applyListStep = (list: CleanViewChecklist, step: { advance?: unknown; done?: unknown; start?: unknown }): CleanViewChecklist => {
  if (list.source !== 'list') return list
  let tasks = [...list.tasks]
  if (step.advance === true) {
    const active = tasks.findIndex(one => one.status === 'active')
    if (active >= 0) tasks[active] = { ...tasks[active]!, status: 'done', percent: 100, hasReported: true }
    const next = tasks.findIndex((one, i) => i > active && one.status === 'upcoming')
    if (next >= 0) tasks[next] = { ...tasks[next]!, status: 'active', percent: 0, hasReported: false }
  }
  if (Array.isArray(step.done)) {
    for (const n of step.done) {
      const i = Number(n) - 1
      if (tasks[i] !== undefined) tasks[i] = { ...tasks[i]!, status: 'done', percent: 100, hasReported: true }
    }
  }
  const start = Number(step.start) - 1
  if (Number.isInteger(start) && tasks[start] !== undefined) {
    tasks = tasks.map((one, i) =>
      i === start ? { ...one, status: 'active', percent: 0, hasReported: false } : one.status === 'active' ? { ...one, status: 'upcoming' } : one,
    )
  }

  return moving({ ...list, tasks })
}

// TaskCreate adds a row; TaskUpdate changes one (or removes it when deleted).
export const addListTask = (list: CleanViewChecklist, id: string, subject: string): CleanViewChecklist => {
  const tasks = list.source === 'list' ? list.tasks : []

  return moving({ ...list, source: 'list', tasks: [...tasks, task(`t${id}`, cleanName(subject), 'upcoming')] })
}

export const updateListTask = (list: CleanViewChecklist, id: string, change: { status?: unknown; subject?: unknown }): CleanViewChecklist => {
  if (list.source !== 'list') return list
  if (change.status === 'deleted') return { ...list, tasks: list.tasks.filter(one => one.id !== `t${id}`) }
  const status = typeof change.status === 'string' ? STATUS[change.status] : undefined

  return moving({
    ...list,
    tasks: list.tasks.map(one => {
      if (one.id !== `t${id}`) return status === 'active' && one.status === 'active' ? { ...one, status: 'upcoming' } : one
      const name = typeof change.subject === 'string' ? cleanName(change.subject) : one.name
      if (status === undefined) return { ...one, name }

      return { ...one, name, status, percent: status === 'done' ? 100 : one.percent, hasReported: status === 'done' || one.hasReported }
    }),
  })
}

// ---------------------------------------------------------------- waiting and failing

export const PERMISSION_REASON = 'Claude needs your OK to continue'
export const QUESTION_REASON = 'Claude has a question for you'
export const REPLY_REASON = 'Claude is waiting for your reply'
export const SAID_NO = 'you said no to a step, so Claude paused'
export const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'

export const needsYou = (list: CleanViewChecklist, reason: string): CleanViewChecklist => ({
  ...list,
  phase: 'needsYou',
  needsYouReason: reason,
  stuckReason: null,
})

export const stuck = (list: CleanViewChecklist, reason: string): CleanViewChecklist => ({
  ...list,
  phase: 'stuck',
  stuckReason: reason,
  needsYouReason: null,
})

// The tool's answer when a person refused it at the permission prompt.
export const isRefusedByPerson = (text: string | undefined): boolean =>
  typeof text === 'string' && /doesn't want to proceed|does not want to proceed|user (rejected|denied|declined)|permission (was )?denied by the user/i.test(text)

// Which notifications mean Claude is waiting on the person.
export const notificationReason = (type: string): string | null =>
  /permission/i.test(type) ? PERMISSION_REASON : /elicitation|question/i.test(type) ? QUESTION_REASON : null

// ---------------------------------------------------------------- the end of a turn

// An API error as one calm sentence.
export const errorSentence = (kind: string | null, details = ''): string => {
  const text = `${kind ?? ''} ${details}`.toLowerCase()
  if (/prompt is too long|context|too many tokens/.test(text)) return 'type /compact and try again'
  if (kind === 'rate_limit' || /rate.?limit|usage limit/.test(text)) return 'you hit your usage limit, try again a little later'
  if (kind === 'overloaded' || kind === 'server_error' || /overloaded|529|5\d\d/.test(text)) return "Claude's servers are busy, try again in a minute"
  if (/authentication|oauth|login|401|403/.test(text)) return 'type /login'
  if (kind === 'billing_error' || /billing/.test(text)) return 'there is a problem with your billing, check your account'
  if (/network|connect|socket|fetch failed|timed? ?out|econn|enotfound/.test(text)) return 'the internet connection dropped'
  if (kind === 'max_output_tokens') return 'the answer ran too long, ask for a shorter one'

  return 'something went wrong, try again'
}

export const REFUSAL = "Claude couldn't help with that request"

export type TurnEnd = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; errorKind: string | null; errorDetails: string }

export const finishTurn = (list: CleanViewChecklist, end: TurnEnd, now: number): CleanViewChecklist => {
  if (end.reason === 'error') return { ...stuck(list, errorSentence(end.errorKind, end.errorDetails)), finishedAt: now }
  if (end.reason === 'refusal') return { ...stuck(list, REFUSAL), finishedAt: now }
  if (end.reason === 'aborted') return { ...list, phase: 'stopped', needsYouReason: null, stuckReason: null, finishedAt: now }
  const isUnfinished = hasPlan(list) && list.tasks.some(one => one.status !== 'done')
  if (isUnfinished) return needsYou(list, REPLY_REASON)

  // A job that never had a real plan (a quick question) ends as one line.
  return {
    ...list,
    phase: 'done',
    needsYouReason: null,
    stuckReason: null,
    finishedAt: now,
    isCollapsed: !hasPlan(list),
    tasks: list.tasks.map(one => ({ ...one, status: 'done', percent: 100, hasReported: true })),
  }
}

// A prompt starts a new job unless one is still going or waits on a reply.
export const continuesJob = (list: CleanViewChecklist | null): boolean =>
  list !== null && (list.phase === 'working' || list.phase === 'needsYou')

export const isRealPrompt = (text: string): boolean => {
  const words = text.trim()

  return words !== '' && !words.startsWith('/') && !words.startsWith('<')
}

// The clock runs only while a job is working or waits on the person.
export const isLive = (phase: CleanViewPhase | undefined): boolean => phase === 'working' || phase === 'needsYou'

// ---------------------------------------------------------------- the gate (terminal only)

export const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL, PROGRESS_TOOL])

export const GATE_MESSAGE =
  `Clean View: call ${PLAN_TOOL} first with the steps of this job in plain English (load it with ToolSearch if it is deferred), or write a to-do list. Then go ahead.`

export const shouldGate = (call: { isEnabled: boolean; isTerminal: boolean; agentId?: string; tool: string; isPlanned: boolean }): boolean =>
  call.isEnabled &&
  call.isTerminal &&
  call.agentId === undefined &&
  !call.isPlanned &&
  !ALWAYS_ALLOWED.has(call.tool) &&
  !call.tool.startsWith('mcp__ccd_')

// ---------------------------------------------------------------- what Claude is told

export const composeText = (hasTaskList: boolean): string =>
  [
    'Clean View is on: the person sees a plain-English checklist of your work instead of tool calls.',
    '- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".',
    '- Never put file paths, file names, commands, code or tool names in a step name.',
    hasTaskList
      ? `- Your task list is the plan: keep it as you already do. Call ${PROGRESS_TOOL} with a step's name and a percent as real progress happens, and with 100 the moment a step finishes.`
      : `- For every request, even a quick question, call ${PLAN_TOOL} first with 2 to 8 short steps in order (load it with ToolSearch if it is deferred). Then call ${PROGRESS_TOOL} as real progress happens, and with 100 the moment a step finishes. If you have TodoWrite or TaskCreate, your to-do list can be the plan instead.`,
  ].join('\n')

// ---------------------------------------------------------------- drawing helpers

export const elapsedText = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const METER = 10

// Ten cells: full when done, filled to the percent, a moving sweep before the
// first report, empty for what is still to come.
export const meterCells = (one: CleanViewTask, frame: number): string => {
  if (one.status === 'done') return '█'.repeat(METER)
  if (one.status === 'upcoming') return '░'.repeat(METER)
  if (!one.hasReported) {
    const at = frame % (METER + 2)

    return Array.from({ length: METER }, (_, i) => (i >= at - 2 && i <= at ? '█' : '░')).join('')
  }
  const filled = Math.round(one.percent / 10)

  return '█'.repeat(filled) + '░'.repeat(METER - filled)
}

export type RowView = { mark: '✓' | '▶' | '‖' | '○'; name: string; label: string; tone: 'done' | 'active' | 'upcoming' }

export const rowsOf = (list: CleanViewChecklist): RowView[] => {
  let seenUpcoming = false

  return list.tasks.map(one => {
    if (one.status === 'done') return { mark: '✓', name: one.name, label: 'Done', tone: 'done' }
    if (one.status === 'active') {
      return {
        mark: list.phase === 'needsYou' ? '‖' : '▶',
        name: one.name,
        label: one.hasReported ? `${one.percent}%` : 'Working',
        tone: 'active',
      }
    }
    const label = seenUpcoming ? 'Up next' : 'Next'
    seenUpcoming = true

    return { mark: '○', name: one.name, label, tone: 'upcoming' }
  })
}

export type HeaderView = { kind: CleanViewPhase; badge: string | null; text: string }

export const headerOf = (list: CleanViewChecklist, now: number, stopWord: string): HeaderView => {
  const ran = elapsedText((list.finishedAt ?? now) - list.startedAt)
  switch (list.phase) {
    case 'needsYou':
      return { kind: 'needsYou', badge: 'Needs you', text: list.needsYouReason ?? PERMISSION_REASON }
    case 'stuck':
      return { kind: 'stuck', badge: null, text: `⚠ Stuck: ${list.stuckReason ?? KEEPS_FAILING}` }
    case 'stopped':
      return { kind: 'stopped', badge: null, text: `■ Stopped · ${list.title} · ${stopWord}` }
    case 'done':
      return { kind: 'done', badge: null, text: `✓ All done · ${list.title} · took ${ran}` }
    default:
      return { kind: list.phase, badge: null, text: `${list.title} · ${ran}` }
  }
}

// The name column's width so a row never wraps: mark, gap, name, gap, ten
// meter cells, gap, the widest label ("Working", "Up next").
export const nameWidth = (columns: number): number => Math.max(4, columns - 2 - 1 - METER - 1 - 7)

export const clip = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
