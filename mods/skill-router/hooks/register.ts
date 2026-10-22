import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import { CONDUCTOR } from './conductor'
import {
  JEV_URL,
  PINS,
  REVIEWER,
  REVIEW_ASK,
  TOUCH_TOOLS,
  agentJevOptions,
  agentJevRequest,
  agentTierOf,
  appendLog,
  bareName,
  clip,
  decide,
  decideAgent,
  jevOptions,
  jevRequest,
  logLine,
  parseCount,
  parseJev,
  stopDecision,
  summary,
  verdictOf,
} from './logic'
import type { JevAnswer, LogEntry, Tier } from './logic'

type D = EngineInterface

const COMMAND = 'skill-router'
const ENABLED = 'enabled'
const AGENTS = 'agents'
const REVIEW = 'review'
const LOG = 'log'

// The pick for the turn in progress. A reload mid-turn drops it, and the turn
// finishes on the session model: the safe side.
let pending: { model: string | null; entry: LogEntry } | null = null
let lastPrompt = ''
let apiKey: string | null = null

// The review gate for the prompt in progress: the step of the last real work
// and of the last review spawn. A reload drops both, so the gate lets the turn
// end: the safe side.
let step = 0
let lastTouch = 0
let lastReview = 0
// Agents with a log line waiting for their turn's tokens.
const tracked = new Set<string>()

// ---------------------------------------------------------------- store

const isOn = async ($: D, key: string): Promise<boolean> => ((await $.store.get(key)) ?? true) === true

const isEnabled = ($: D): Promise<boolean> => isOn($, ENABLED)

const readLog = async ($: D): Promise<LogEntry[]> => ((await $.store.get(LOG)) as LogEntry[] | undefined) ?? []

// Agents spawn in parallel, so log writes (read, change, write) take turns.
let logQueue: Promise<unknown> = Promise.resolve()
const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const run = logQueue.then(work, work)
  logQueue = run.catch(() => undefined)

  return run
}

const writeEntry = ($: D, entry: LogEntry) =>
  serial(async () => {
    await $.store.set(LOG, appendLog(await readLog($), entry))
  })

// ---------------------------------------------------------------- key

// Environment first, then the login Keychain. Only a found key is cached, so
// one added mid-session is picked up on the next skill.
const readKey = async ($: D): Promise<string | null> => {
  if (apiKey) return apiKey
  const fromEnv = await $.env.get('OPENROUTER_API_KEY')
  if (fromEnv) return (apiKey = fromEnv)
  try {
    const found = await $.process.run(['security', 'find-generic-password', '-s', 'OPENROUTER_API_KEY', '-w'], {
      timeoutMs: 5000,
    })
    if (found.exitCode === 0 && found.stdout.trim()) apiKey = found.stdout.trim()
  } catch {
    // No Keychain here (not macOS, or no process access): routing falls back.
  }

  return apiKey
}

// ---------------------------------------------------------------- routing

const askJev = async (
  $: D,
  request: object,
  options: readonly Tier[],
): Promise<{ answer: JevAnswer | null; ms: number; note?: string }> => {
  const started = await $.clock.now()
  const key = await readKey($)
  if (!key) return { answer: null, ms: 0, note: 'no OPENROUTER_API_KEY' }
  try {
    const response = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'skill-router' },
      body: JSON.stringify(request),
    })
    const ms = Math.round((await $.clock.now()) - started)
    if (!response.ok) return { answer: null, ms, note: `Jev HTTP ${response.status}` }

    return { answer: parseJev(response.text, options), ms }
  } catch {
    return { answer: null, ms: Math.round((await $.clock.now()) - started), note: 'Jev call failed' }
  }
}

const route = async ($: D, skill: string, description: string) => {
  if (!(await isEnabled($))) return
  const session = await $.session.model()
  const options = jevOptions(skill, session)
  const asked = options ? await askJev($, jevRequest(skill, description, lastPrompt, options), options) : undefined
  const decision = decide(skill, session, asked?.answer)

  // A second skill in one turn: the first one's line goes in as it stands.
  if (pending) await writeEntry($, pending.entry)

  const entry: LogEntry = {
    at: await $.clock.now(),
    skill,
    session,
    source: decision.source,
    pick: decision.pick,
    switched: decision.model !== null,
    ...(asked?.answer ? { probability: asked.answer.probability, jevCost: asked.answer.cost } : {}),
    ...(asked ? { jevMs: asked.ms } : {}),
    ...(decision.note || asked?.note ? { note: [asked?.note, decision.note].filter(Boolean).join('; ') } : {}),
  }
  pending = { model: decision.model, entry }
  $.ui.status(decision.model ? `${bareName(skill)} on ${decision.pick}` : undefined)
}

// The model for one subagent, and its log line, or null to leave the spawn
// alone and unlogged (agent routing off, and not the reviewer).
const routeAgent = async ($: D, e: AgentSpawnInput): Promise<{ model: string | null; entry: LogEntry } | null> => {
  const isReviewer = e.subagentType === REVIEWER
  if (!isReviewer && !(await isOn($, AGENTS))) return null
  const options = agentJevOptions(e, e.parentModel)
  const asked = options
    ? await askJev($, agentJevRequest(e.subagentType, e.description, e.prompt, options), options)
    : undefined
  const decision = decideAgent(e, e.parentModel, asked?.answer)

  const entry: LogEntry = {
    at: await $.clock.now(),
    kind: isReviewer ? 'review' : 'agent',
    skill: e.subagentType,
    task: clip(e.description, 80),
    session: e.parentModel,
    source: decision.source,
    pick: decision.pick,
    switched: decision.model !== null && decision.pick !== agentTierOf(e.parentModel),
    ...(asked?.answer ? { probability: asked.answer.probability, jevCost: asked.answer.cost } : {}),
    ...(asked ? { jevMs: asked.ms } : {}),
    ...(decision.note || asked?.note ? { note: [asked?.note, decision.note].filter(Boolean).join('; ') } : {}),
  }

  return { model: decision.model, entry }
}

// An agent's turn ended: its tokens, and a review's verdict, go on its line.
const finishAgent = async (
  $: D,
  agentId: string,
  answer: string,
  durationMs: number,
  tokens: Pick<LogEntry, 'tokensIn' | 'tokensOut'>,
) =>
  serial(async () => {
    const list = await readLog($)
    const at = list.findLastIndex(entry => entry.agentId === agentId)
    const entry = list[at]
    if (!entry) return
    const verdict = entry.kind === 'review' ? verdictOf(answer) : undefined
    list[at] = { ...entry, turnMs: durationMs, ...tokens, ...(verdict ? { verdict } : {}) }
    await $.store.set(LOG, list)
  })

const isTouch = (e: { tool: string; action?: unknown }): boolean =>
  (TOUCH_TOOLS as readonly string[]).includes(e.tool) &&
  (e.tool !== 'Artifact' || e.action === undefined || e.action === 'publish')

// ---------------------------------------------------------------- command

const commandText = async ($: D, args: string): Promise<string> => {
  const [word = 'status', rest = ''] = args.trim().split(/\s+/, 2)
  if (word === 'on' || word === 'off') {
    await $.store.set(ENABLED, word === 'on')

    return `Skill router is ${word}.`
  }
  if ((word === 'agents' || word === 'review') && (rest === 'on' || rest === 'off')) {
    await $.store.set(word === 'agents' ? AGENTS : REVIEW, rest === 'on')

    return word === 'agents' ? `Agent routing is ${rest}.` : `Fable review is ${rest}.`
  }
  if (word === 'log') {
    const list = await readLog($)
    const lines = list.slice(-parseCount(rest, 20)).map(logLine)

    return lines.length ? [...lines, '', summary(list)].join('\n') : 'No picks logged yet.'
  }
  if (word === 'pins') return `Pinned to Haiku: ${PINS.join(', ')}.`
  if (word === 'clear') {
    await serial(() => $.store.set(LOG, []))

    return 'Log cleared.'
  }
  const key = (await readKey($)) ? 'found' : 'missing'

  const state = async (k: string) => ((await isOn($, k)) ? 'on' : 'off')

  return [
    `Skill routing ${await state(ENABLED)}, agent routing ${await state(AGENTS)}, Fable review ${await state(REVIEW)}. OpenRouter key: ${key}.`,
    summary(await readLog($)),
    'Use: /skill-router on | off | agents on|off | review on|off | status | log [n] | pins | clear',
  ].join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Skill and agent model router, Fable review: on, off, agents, review, status, log, pins',
    })

    return next(e)
  })

  // The conductor rules, for the main session only. Fires again after a
  // compaction, so the rules survive it. A resume or fork carries the
  // transcript, rules and all, so adding them there would double them.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id !== undefined || e.source === 'resume' || e.source === 'fork') return done

    return { ...done, additionalContext: [...(done.additionalContext ?? []), CONDUCTOR] }
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await commandText($, e.args) })).catch(() => ({
    text: 'Skill router hit a problem reading its settings.',
  }))

  // A new prompt ends the last pick, so the session model is back.
  on('prompt.submit', ($, e, next) => {
    if (!e.isMeta) {
      pending = null
      lastPrompt = e.command ? `/${e.command.name} ${e.command.args}`.trim() : e.text
      lastTouch = 0
      lastReview = 0
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const description = typeof e.frontmatter.description === 'string' ? e.frontmatter.description : ''
    try {
      await route($, e.skill, description)
    } catch {
      // Routing never stops a skill from loading.
    }

    return next(e)
  })

  // Main loop only: a subagent keeps the model it was given.
  on('turn.step', async function* ($, e, next) {
    const model = e.agentId === undefined ? pending?.model : null

    return yield* next(model ? { ...e, model } : e)
  })

  // Real work, in the main loop or any subagent, arms the review gate.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isTouch(e) && ran.deny === undefined && ran.isError !== true) lastTouch = ++step

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    let routed: Awaited<ReturnType<typeof routeAgent>> = null
    try {
      routed = await routeAgent($, e)
    } catch {
      // Routing never stops an agent from starting.
    }
    const started = await next(routed?.model ? { ...e, model: routed.model } : e)
    if (started.deny !== undefined) return started

    // The spawn, not the answer, satisfies the gate. A reviewer run in the
    // background still holds the turn open through `background_tasks`.
    if (e.subagentType === REVIEWER) lastReview = ++step
    if (routed) {
      const agentId = started.agentId
      if (agentId) tracked.add(agentId)
      await writeEntry($, { ...routed.entry, ...(agentId ? { agentId } : {}) })
    }

    return started
  })

  // Real work and no review yet: keep the turn going until the reviewer runs.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    if (done.block) return done
    const decision = stopDecision({
      isReviewOn: await isOn($, REVIEW),
      isStopHookActive: e.stop_hook_active,
      backgroundTasks: e.background_tasks?.length ?? 0,
      isTouched: lastTouch > 0,
      isReviewed: lastReview > lastTouch,
    })
    if (decision.note === 'review skipped') {
      lastTouch = 0
      await writeEntry($, {
        at: await $.clock.now(),
        kind: 'review',
        skill: REVIEWER,
        session: await $.session.model(),
        source: 'kept',
        pick: null,
        switched: false,
        note: decision.note,
      })
    }

    return decision.isBlocked ? { ...done, block: REVIEW_ASK } : done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined && tracked.delete(e.agentId)) {
      const usage = e.usage
        ? {
            tokensIn:
              e.usage.input_tokens + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0),
            tokensOut: e.usage.output_tokens,
          }
        : {}
      await finishAgent($, e.agentId, e.answer, e.durationMs, usage)
    }
    if (e.agentId === undefined && pending) {
      const entry: LogEntry = {
        ...pending.entry,
        turnMs: e.durationMs,
        // Input counts cache reads and writes too: that is where a switch costs.
        ...(e.usage
          ? {
              tokensIn:
                e.usage.input_tokens + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0),
              tokensOut: e.usage.output_tokens,
            }
          : {}),
      }
      pending = null
      $.ui.status(undefined)
      await writeEntry($, entry)
    }

    return done
  })
}
