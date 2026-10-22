// Pure parts of skill-router: the pin list, the Jev request and answer, the
// skill and agent decisions, the review gate, and the log. No `$` here, so the
// tests run it directly.

import type { AgentCard } from '../types'

// ---------------------------------------------------------------- settings

// Simple fixed-step skills, signed off by Ian 2026-10-21. Bare names: a synced
// skill may arrive as `anthropic-skills:docket` or `docket`.
export const PINS = ['docket', 'schedule', 'loop', 'keybindings-help', 'consolidate-memory'] as const

export const TIERS = ['haiku', 'sonnet', 'opus'] as const
export type Tier = (typeof TIERS)[number]

export const MODEL_IDS: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
export const JEV_MODEL = '~typesafe/jev-latest'

// Jev's own `confidence` ran 0.38 on a clear call; the picked option's
// probability is the steadier gate.
export const MIN_PROBABILITY = 0.5
export const LOG_LIMIT = 1000

const CRITERIA: Record<Tier, string> = {
  haiku: 'Fixed steps, lookups, formatting, filing, simple tool calls. No judgment, no published writing.',
  sonnet: 'Normal writing and code edits touching a few files; moderate judgment.',
  opus: "Multi-file design, hard judgment calls, or copy in Ian's voice that will be published.",
}

const AGENT_CRITERIA: Record<Tier, string> = {
  haiku: 'Searching and reading files, lookups, listing, formatting, filing. No edits that need judgment.',
  sonnet: 'Code or doc edits in a few files with a clear brief; moderate judgment.',
  opus: "Design across many files, hard judgment calls, debugging with no clear cause, or copy in Ian's voice that will be published.",
}

// The Fable reviewer, as a plugin agent file names it.
export const REVIEWER = 'skill-router:final-review'
export const REVIEWER_MODEL = 'fable'

// Built-ins that make their own model choice: never routed.
export const AGENT_SKIPS = ['claude-code-guide', 'statusline-setup'] as const

// Tools whose success means the turn did real work. Bash is left out: a read
// and a write look the same from here.
export const TOUCH_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Artifact'] as const

// ---------------------------------------------------------------- names

export const bareName = (skill: string): string => skill.slice(skill.lastIndexOf(':') + 1)

export const isPinned = (skill: string): boolean => (PINS as readonly string[]).includes(bareName(skill))

// The tier a model ID belongs to, or null for one not ranked here (fable).
export const tierOf = (model: string): Tier | null => TIERS.find(tier => model.includes(tier)) ?? null

// Down only: Jev chooses among the session's tier and those below it.
export const tiersUpTo = (session: Tier): Tier[] => TIERS.slice(0, TIERS.indexOf(session) + 1)

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

// ---------------------------------------------------------------- Jev

export const jevRequest = (skill: string, description: string, request: string, options: readonly Tier[]) => ({
  model: JEV_MODEL,
  state: {
    skill: bareName(skill),
    skill_description: clip(description, 600),
    request: clip(request, 1500),
  },
  questions: {
    model: {
      type: 'choice',
      instructions: 'Which is the smallest Claude model that will do this skill run well?',
      criteria: Object.fromEntries(options.map(tier => [tier, CRITERIA[tier]])),
    },
  },
})

export type JevAnswer = { choice: Tier; probability: number; cost: number }

export const parseJev = (text: string, options: readonly Tier[]): JevAnswer | null => {
  try {
    const data = JSON.parse(text)
    const answer = data?.answers?.model
    if (answer?.type !== 'choice' || !options.includes(answer.choice)) return null
    const choice = answer.choice as Tier

    return {
      choice,
      probability: Number(answer.probabilities?.[choice] ?? 0),
      cost: Number(data.usage?.cost ?? 0),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- decision

// What to ask Jev, or null when the pin list or the session model settles it.
export const jevOptions = (skill: string, session: string): Tier[] | null => {
  const tier = tierOf(session)
  if (isPinned(skill) || tier === null || tier === 'haiku') return null

  return tiersUpTo(tier)
}

export type Source = 'pin' | 'jev' | 'kept' | 'explicit'

export type Decision = {
  source: Source
  pick: Tier | null
  // The model to switch to for the rest of the turn; null keeps the session's.
  model: string | null
  note?: string
}

// `jev` is undefined when Jev was not asked, null when the call failed.
export const decide = (skill: string, session: string, jev?: JevAnswer | null): Decision => {
  const tier = tierOf(session)

  if (isPinned(skill)) {
    return { source: 'pin', pick: 'haiku', model: tier === 'haiku' ? null : MODEL_IDS.haiku }
  }
  if (tier === null) return { source: 'kept', pick: null, model: null, note: 'session model not ranked' }
  if (tier === 'haiku') return { source: 'kept', pick: 'haiku', model: null, note: 'already smallest' }
  if (jev === undefined || jev === null) return { source: 'kept', pick: null, model: null, note: 'Jev unavailable' }
  if (jev.probability < MIN_PROBABILITY) {
    return { source: 'kept', pick: jev.choice, model: null, note: `Jev unsure (${jev.probability.toFixed(2)})` }
  }

  return { source: 'jev', pick: jev.choice, model: jev.choice === tier ? null : MODEL_IDS[jev.choice] }
}

// ---------------------------------------------------------------- agents

// For agents Fable ranks above Opus, so a Fable session still routes its
// subagents. Jev is never offered Fable.
export type AgentTier = Tier | 'fable'
const AGENT_RANK: readonly AgentTier[] = [...TIERS, 'fable']

export const agentTierOf = (model: string): AgentTier | null =>
  model.includes('fable') ? 'fable' : tierOf(model)

export const agentJevRequest = (agentType: string, description: string, brief: string, options: readonly Tier[]) => ({
  model: JEV_MODEL,
  state: {
    agent_type: bareName(agentType),
    task: clip(description, 200),
    brief: clip(brief, 1500),
  },
  questions: {
    model: {
      type: 'choice',
      instructions: "Which is the smallest Claude model that will do this subagent's task well?",
      criteria: Object.fromEntries(options.map(tier => [tier, AGENT_CRITERIA[tier]])),
    },
  },
})

// The facts of a spawn the decision reads, as `agent.spawn` carries them.
export type Spawn = {
  subagentType: string
  model?: string
  fork: boolean
  resume?: unknown
  workflow?: unknown
  isTeammate?: true
}

export type AgentDecision = {
  source: Source
  pick: AgentTier | null
  // The model to hand the spawn; null leaves the call as it came.
  model: string | null
  note?: string
}

// What to ask Jev for this spawn, or null when nothing needs asking.
export const agentJevOptions = (spawn: Spawn, parent: string): Tier[] | null => {
  if (agentSkip(spawn) || spawn.subagentType === REVIEWER || spawn.model) return null
  const tier = agentTierOf(parent)
  if (tier === null || tier === 'haiku') return null

  return tier === 'fable' ? [...TIERS] : tiersUpTo(tier)
}

const agentSkip = (spawn: Spawn): string | null => {
  if (spawn.fork) return 'fork inherits'
  if (spawn.resume) return 'resumed run'
  if (spawn.workflow) return 'workflow agent'
  if (spawn.isTeammate) return 'teammate'
  if ((AGENT_SKIPS as readonly string[]).includes(spawn.subagentType)) return 'picks its own model'

  return null
}

// `jev` is undefined when Jev was not asked, null when the call failed.
export const decideAgent = (spawn: Spawn, parent: string, jev?: JevAnswer | null): AgentDecision => {
  const skip = agentSkip(spawn)
  if (skip) return { source: 'kept', pick: null, model: null, note: skip }
  if (spawn.subagentType === REVIEWER) return { source: 'pin', pick: 'fable', model: REVIEWER_MODEL }

  const tier = agentTierOf(parent)
  if (spawn.model) {
    // Down only, even when the conductor named a model itself.
    const asked = agentTierOf(spawn.model)
    if (asked && tier && AGENT_RANK.indexOf(asked) > AGENT_RANK.indexOf(tier)) {
      return { source: 'explicit', pick: tier, model: parent, note: `asked for ${asked}, held to ${tier}` }
    }

    return { source: 'explicit', pick: asked, model: null }
  }
  if (tier === null) return { source: 'kept', pick: null, model: null, note: 'session model not ranked' }
  if (tier === 'haiku') return { source: 'kept', pick: 'haiku', model: null, note: 'already smallest' }
  if (jev === undefined || jev === null) return { source: 'kept', pick: null, model: null, note: 'Jev unavailable' }
  if (jev.probability < MIN_PROBABILITY) {
    return { source: 'kept', pick: jev.choice, model: null, note: `Jev unsure (${jev.probability.toFixed(2)})` }
  }

  // Set even when it matches the session: left unset, the agent's own
  // definition could pick something else.
  return { source: 'jev', pick: jev.choice, model: MODEL_IDS[jev.choice] }
}

// ---------------------------------------------------------------- review gate

export type StopFacts = {
  isReviewOn: boolean
  // The model is already going on because a Stop hook asked: never ask twice.
  isStopHookActive: boolean
  backgroundTasks: number
  isTouched: boolean
  isReviewed: boolean
}

export type StopDecision = { isBlocked: boolean; note?: string }

export const stopDecision = (f: StopFacts): StopDecision => {
  if (!f.isReviewOn || !f.isTouched || f.isReviewed) return { isBlocked: false }
  if (f.isStopHookActive) return { isBlocked: false, note: 'review skipped' }
  if (f.backgroundTasks > 0) return { isBlocked: false, note: 'waiting on background work' }

  return { isBlocked: true }
}

export const REVIEW_ASK = `Run ${REVIEWER} on this turn's work before you finish. Brief it with Ian's request and the files that changed. Fix what it marks FIX, or tell Ian why you did not.`

// PASS or FIX: the first word of the reviewer's answer, so "PASS (no fixes
// needed)" still reads as PASS.
export const verdictOf = (answer: string): 'PASS' | 'FIX' | undefined => {
  const word = /^\W*(PASS|FIX)\b/i.exec(answer.trim())?.[1]?.toUpperCase()

  return word === 'PASS' || word === 'FIX' ? word : undefined
}

// ---------------------------------------------------------------- log

// `kind` is absent on entries from 0.1, which were all skills. For an agent or
// a review, `skill` holds the agent type.
export type Kind = 'skill' | 'agent' | 'review'

export type LogEntry = {
  at: number
  kind?: Kind
  skill: string
  session: string
  source: Source
  pick: AgentTier | null
  switched: boolean
  agentId?: string
  task?: string
  verdict?: 'PASS' | 'FIX'
  probability?: number
  jevMs?: number
  jevCost?: number
  note?: string
  turnMs?: number
  tokensIn?: number
  tokensOut?: number
  // An agent's tool calls, for the Agents pane's progress estimate (0.3 on).
  toolCalls?: number
}

export const appendLog = (list: readonly LogEntry[], entry: LogEntry): LogEntry[] => [...list, entry].slice(-LOG_LIMIT)

export const kindOf = (e: LogEntry): Kind => e.kind ?? 'skill'

const shortModel = (model: string): string => agentTierOf(model) ?? model

const stamp = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const logLine = (e: LogEntry): string => {
  const route = e.switched ? `${shortModel(e.session)} → ${e.pick}` : `stayed ${shortModel(e.session)}`
  const kind = kindOf(e)
  const parts = [stamp(e.at), `${kind === 'skill' ? '' : `${kind} `}${bareName(e.skill)}`, e.source, route]
  if (e.verdict) parts.push(e.verdict)
  if (e.probability !== undefined) parts.push(`p ${e.probability.toFixed(2)}`)
  if (e.jevMs !== undefined) parts.push(`Jev ${e.jevMs} ms`)
  if (e.jevCost !== undefined) parts.push(`$${e.jevCost.toFixed(6)}`)
  if (e.turnMs !== undefined) parts.push(`turn ${(e.turnMs / 1000).toFixed(1)} s`)
  if (e.tokensIn !== undefined) parts.push(`${e.tokensIn} in / ${e.tokensOut ?? 0} out`)
  if (e.note) parts.push(e.note)

  return parts.join(' · ')
}

export const summary = (list: readonly LogEntry[]): string => {
  const skills = list.filter(e => kindOf(e) === 'skill')
  const agents = list.filter(e => kindOf(e) === 'agent')
  const reviews = list.filter(e => kindOf(e) === 'review' && e.source === 'pin')
  const count = (from: readonly LogEntry[], source: Source) => from.filter(e => e.source === source).length
  const cost = list.reduce((sum, e) => sum + (e.jevCost ?? 0), 0)
  const switched = skills.filter(e => e.switched).length
  const verdicts = (v: string) => reviews.filter(e => e.verdict === v).length
  const reviewIn = reviews.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0)
  const skipped = list.filter(e => kindOf(e) === 'review' && e.note === 'review skipped').length

  return [
    `${skills.length} skill picks: ${count(skills, 'pin')} pinned, ${count(skills, 'jev')} by Jev, ${count(skills, 'kept')} kept. ${switched} switched model.`,
    `${agents.length} agents: ${count(agents, 'jev')} by Jev, ${count(agents, 'explicit')} named by the session, ${count(agents, 'kept')} kept.`,
    `${reviews.length} Fable reviews: ${verdicts('PASS')} PASS, ${verdicts('FIX')} FIX, ${reviewIn} tokens in. ${skipped} skipped.`,
    `Jev cost $${cost.toFixed(6)}.`,
  ].join('\n')
}

export const parseCount = (args: string, fallback: number): number => {
  const n = Number.parseInt(args, 10)

  return Number.isFinite(n) && n > 0 ? Math.min(n, LOG_LIMIT) : fallback
}

// ---------------------------------------------------------------- agents pane

export const MODEL_COLOR: Record<AgentTier, string> = {
  haiku: '#3DD68C',
  sonnet: '#58A6FF',
  opus: '#BC8CFF',
  fable: '#F2C46D',
}
export const UNKNOWN_COLOR = '#7D8590'

export const colorOf = (model: string | null): string => {
  const tier = model ? agentTierOf(model) : null

  return tier ? MODEL_COLOR[tier] : UNKNOWN_COLOR
}

export const modelLabel = (model: string | null): string => (model ? (agentTierOf(model) ?? model) : '…')

// Tool calls a run usually takes, until the log has runs of that type.
const FIRST_GUESS: Record<string, number> = { Explore: 15, Plan: 15, 'general-purpose': 20, [REVIEWER]: 12 }
const GUESS = 15
const HISTORY = 20

// The average tool calls of the last runs of this agent type, or a first
// guess while fewer than three are logged.
export const expectedTools = (list: readonly LogEntry[], agentType: string): number => {
  const runs = list.filter(e => e.skill === agentType && e.toolCalls !== undefined).slice(-HISTORY)
  if (runs.length < 3) return FIRST_GUESS[agentType] ?? GUESS
  const mean = runs.reduce((sum, e) => sum + (e.toolCalls ?? 0), 0) / runs.length

  return Math.max(3, Math.round(mean))
}

// How full the bar is. An agent reports no percent done, so a running bar
// fills by tool calls against the usual count and holds at 90% until it ends.
export const progressOf = (card: AgentCard): number => {
  if (card.stage === 'done') return 1
  if (card.stage === 'routing') return 0.03
  if (card.stage === 'denied') return 0

  return Math.min(0.9, Math.max(0.05, card.tools / Math.max(1, card.expected)))
}

// The last tool, as a short line: the tool and what it was pointed at.
export const toolLine = (e: { tool: string } & Record<string, unknown>): string => {
  const target = ['pattern', 'file_path', 'path', 'command', 'url', 'query', 'description', 'skill']
    .map(key => e[key])
    .find(value => typeof value === 'string' && value.trim() !== '') as string | undefined
  const short = target ? (target.includes('/') && !target.includes(' ') ? target.slice(target.lastIndexOf('/') + 1) : target) : ''

  return clip(short ? `${e.tool} ${short.replace(/\s+/g, ' ')}` : e.tool, 60)
}

// How the model was chosen, in one line.
export const routeText = (card: AgentCard): string => {
  if (card.stage === 'routing') return 'Asking Jev which model to use…'
  const model = modelLabel(card.model)
  if (card.source === 'jev') {
    const offered = card.offered?.length ? ` from ${card.offered.join(' / ')}` : ''
    const sure = card.probability !== undefined ? ` · p ${card.probability.toFixed(2)}` : ''
    const ms = card.jevMs !== undefined ? ` · ${card.jevMs} ms` : ''

    return `Jev picked ${card.pick ?? model}${offered}${sure}${ms}`
  }
  if (card.source === 'pin') return `Pinned to ${model}`
  if (card.source === 'explicit') return card.note ? `Named by Claude, ${card.note}` : `Named by Claude: ${model}`
  if (card.source === 'kept') {
    const why = card.note ?? 'session model'
    const jevSaid = card.pick && card.note?.startsWith('Jev unsure') ? ` (leaned ${card.pick})` : ''

    return `Kept ${model}: ${why}${jevSaid}`
  }

  return `Agent routing off · runs on ${model}`
}

const seconds = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`)

const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const calls = (n: number): string => `${n} tool call${n === 1 ? '' : 's'}`

// What the agent is doing, or how it ended.
export const statusText = (card: AgentCard): string => {
  if (card.stage === 'routing') return 'Starting'
  if (card.stage === 'denied') return `Refused: ${card.note ?? 'spawn denied'}`
  if (card.stage === 'running') return card.lastTool ? `${calls(card.tools)} · ${card.lastTool}` : 'Started'
  const parts = [card.stage === 'done' ? 'Done' : 'Stopped']
  if (card.endedAt !== undefined) parts.push(seconds(card.endedAt - card.startedAt))
  parts.push(calls(card.tools))
  if (card.tokensIn !== undefined) parts.push(`${thousands(card.tokensIn)} in / ${thousands(card.tokensOut ?? 0)} out`)

  return parts.join(' · ')
}

export const isLive = (card: AgentCard): boolean => card.stage === 'routing' || card.stage === 'running'

export const paneHeading = (cards: readonly AgentCard[]): string => {
  const live = cards.filter(isLive).length
  const ended = cards.length - live

  return [live ? `${live} running` : '', ended ? `${ended} finished` : ''].filter(Boolean).join(' · ') || 'No agents yet'
}
