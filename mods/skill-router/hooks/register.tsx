import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { AgentCard, AgentsView } from '../types'

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
  colorOf,
  decide,
  decideAgent,
  expectedTools,
  jevOptions,
  jevRequest,
  logLine,
  modelLabel,
  parseCount,
  paneHeading,
  parseJev,
  routeText,
  statusText,
  stopDecision,
  summary,
  toolLine,
  verdictOf,
} from './logic'
import type { JevAnswer, LogEntry, Tier } from './logic'
import { MUTED, TEXT, bandCards, bandLine, bandSvg, barText, cardSvg, pixelsFor } from './pane'

type D = EngineInterface

const COMMAND = 'skill-router'
const ENABLED = 'enabled'
const AGENTS = 'agents'
const REVIEW = 'review'
const LOG = 'log'
const VIEW = 'view'

const PANE = 'agents'
const PANE_TITLE = 'Agents'
const NARROW = 'The Agents pane needs a wider window. Run /skill-router pane to open it.'

// The cards for the Agents band and pane, for this session.
const cards = atom({ plugin: 'skill-router', key: 'agents' } as const, [] as AgentCard[])
// Where agents show unasked: the band above the prompt (the default), the
// pane, or nowhere. Kept in $.store across sessions, mirrored here so a
// change redraws the band at once.
const view = atom({ plugin: 'skill-router', key: 'view' } as const, 'band' as AgentsView)
const VIEWS: readonly AgentsView[] = ['band', 'pane', 'off']

const readView = async ($: D): Promise<AgentsView> => {
  const kept = await $.store.get(VIEW)

  return VIEWS.includes(kept as AgentsView) ? (kept as AgentsView) : 'band'
}

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
let cardCount = 0
// One "too narrow" toast a session is enough.
let isNarrowSaid = false

// ---------------------------------------------------------------- store

const isOn = async ($: D, key: string): Promise<boolean> => ((await $.store.get(key)) ?? true) === true

const isEnabled = ($: D): Promise<boolean> => isOn($, ENABLED)

const readLog = async ($: D): Promise<LogEntry[]> => ((await $.store.get(LOG)) as LogEntry[] | undefined) ?? []

// Agents spawn in parallel, so log writes (read, change, write) take turns.
let logQueue: Promise<unknown> = Promise.resolve()
const serial = <T,>(work: () => Promise<T>): Promise<T> => {
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
// one added mid-session is picked up on the next skill. A 401 or 403 from Jev
// drops the cached key (see askJev).
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
    // A refused key is dropped, so a key rotated mid-session is read on the next call.
    if (response.status === 401 || response.status === 403) apiKey = null
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
const routeAgent = async (
  $: D,
  e: AgentSpawnInput,
): Promise<{ model: string | null; entry: LogEntry; offered: Tier[] | null } | null> => {
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

  return { model: decision.model, entry, offered: options }
}

// An agent's turn ended: its tokens, and a review's verdict, go on its line.
const finishAgent = async (
  $: D,
  agentId: string,
  answer: string,
  durationMs: number,
  tokens: Pick<LogEntry, 'tokensIn' | 'tokensOut' | 'toolCalls'>,
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

// ---------------------------------------------------------------- agents pane

const changeCard = ($: D, match: (card: AgentCard) => boolean, change: (card: AgentCard) => Partial<AgentCard>) =>
  update($, cards, list => list.map(card => (match(card) ? { ...card, ...change(card) } : card)))

const byId = (id: string) => (card: AgentCard) => card.id === id

// Unasked, the surface places a pane only when it is wide enough; the command
// is the asked path, placed at any width.
const openPane = async ($: D, isAsked: boolean) => {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  if (!opened.isPlaced && (isAsked || !isNarrowSaid)) {
    isNarrowSaid = true
    $.ui.toast(NARROW)
  }

  return opened.isPlaced
}

// A card for every spawn, routed or not, and the pane opened for it.
const addCard = async ($: D, e: AgentSpawnInput): Promise<string> => {
  // The start time keeps ids apart across a reload, which resets the count
  // while the cards stay.
  const startedAt = await $.clock.now()
  const id = `card-${Math.round(startedAt)}-${++cardCount}`
  const card: AgentCard = {
    id,
    type: e.subagentType,
    task: e.description,
    stage: 'routing',
    model: null,
    tools: 0,
    expected: expectedTools(await readLog($), e.subagentType),
    startedAt,
  }
  await update($, cards, list => [...list, card])
  if ((await read($, view)) === 'pane') await openPane($, false)

  return id
}

const routeFields = (routed: Awaited<ReturnType<typeof routeAgent>>): Partial<AgentCard> => {
  if (!routed) return { source: undefined }
  const { entry, offered } = routed

  return {
    source: entry.source,
    pick: entry.pick,
    ...(offered ? { offered } : {}),
    ...(entry.probability !== undefined ? { probability: entry.probability } : {}),
    ...(entry.jevMs !== undefined ? { jevMs: entry.jevMs } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  }
}

// Pane trouble never stops an agent or a tool call.
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {
    // The pane misses one change; the agent runs on.
  }
}

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
  if (word === 'pane') return (await openPane($, true)) ? 'Agents pane opened.' : NARROW
  if (word === 'view' && (VIEWS as readonly string[]).includes(rest)) {
    const next = rest as AgentsView
    await $.store.set(VIEW, next)
    await update($, view, () => next)

    return {
      band: 'Agents show in a band above the chat box. /skill-router pane opens the full cards.',
      pane: 'Agents show in the pane beside the chat. It opens when an agent starts.',
      off: 'Agents show nowhere until /skill-router pane.',
    }[next]
  }
  if (word === 'pins') return `Pinned to Haiku: ${PINS.join(', ')}.`
  if (word === 'clear') {
    await serial(() => $.store.set(LOG, []))

    return 'Log cleared.'
  }
  const key = (await readKey($)) ? 'found' : 'missing'

  const state = async (k: string) => ((await isOn($, k)) ? 'on' : 'off')

  return [
    `Skill routing ${await state(ENABLED)}, agent routing ${await state(AGENTS)}, Fable review ${await state(REVIEW)}, agents view ${await readView($)}. OpenRouter key: ${key}.`,
    summary(await readLog($)),
    'Use: /skill-router on | off | agents on|off | review on|off | view band|pane|off | pane | status | log [n] | pins | clear',
  ].join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Skill and agent model router, Agents band and pane, Fable review: on, off, agents, review, view, pane, status, log, pins',
    })
    const kept = await readView($)
    await update($, view, () => kept)

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
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) {
      pending = null
      lastPrompt = e.command ? `/${e.command.name} ${e.command.args}`.trim() : e.text
      lastTouch = 0
      lastReview = 0
    }
    // A typed prompt clears the finished cards. A slash command doesn't:
    // /skill-router pane would otherwise open on an empty pane.
    if (!e.isMeta && !e.command) {
      await quietly(async () => {
        const live = (await read($, cards)).filter(card => card.stage === 'routing' || card.stage === 'running')
        await update($, cards, () => live)
        if (live.length === 0) await $.ui.close({ id: PANE })
      })
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
    // A subagent's call moves its card. An id no card holds (a compaction or
    // memory fork) is left alone.
    const agentId = e.agentId
    // Not awaited: the pane never holds up a tool call.
    if (agentId !== undefined) {
      void quietly(async () => {
        if (!(await read($, cards)).some(card => card.agentId === agentId)) return
        const last = toolLine(e as unknown as { tool: string } & Record<string, unknown>)
        await changeCard($, card => card.agentId === agentId, card => ({ tools: card.tools + 1, lastTool: last }))
      })
    }
    const ran = await next(e)
    if (isTouch(e) && ran.deny === undefined && ran.isError !== true) lastTouch = ++step

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    let id: string | null = null
    await quietly(async () => {
      id = await addCard($, e)
    })
    let routed: Awaited<ReturnType<typeof routeAgent>> = null
    try {
      routed = await routeAgent($, e)
    } catch {
      // Routing never stops an agent from starting.
    }
    const card = id as string | null
    if (card) await quietly(() => changeCard($, byId(card), () => routeFields(routed)))
    const started = await next(routed?.model ? { ...e, model: routed.model } : e)
    if (started.deny !== undefined) {
      const reason = started.deny
      const ended = await $.clock.now()
      if (card) await quietly(() => changeCard($, byId(card), () => ({ stage: 'denied', note: reason, endedAt: ended })))

      return started
    }
    if (card) {
      // With no agentId (a workflow's remote agent) no event will ever end
      // the card, so it is marked done at the hand-off.
      const agentId = started.agentId
      const ended = agentId ? undefined : await $.clock.now()
      await quietly(() =>
        changeCard($, byId(card), () => ({
          model: started.model,
          ...(agentId
            ? { stage: 'running', agentId }
            : { stage: 'done', endedAt: ended, note: 'runs remotely, not tracked here' }),
        })),
      )
    }

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
    const agentId = e.agentId
    let toolCalls: number | undefined
    if (agentId !== undefined) {
      const ended = await $.clock.now()
      await quietly(async () => {
        toolCalls = (await read($, cards)).find(card => card.agentId === agentId)?.tools
        await changeCard(
          $,
          card => card.agentId === agentId,
          () => ({
            stage: e.isAborted || e.reason !== 'answer' ? 'stopped' : 'done',
            endedAt: ended,
            ...(e.usage
              ? {
                  tokensIn:
                    e.usage.input_tokens +
                    (e.usage.cache_read_input_tokens ?? 0) +
                    (e.usage.cache_creation_input_tokens ?? 0),
                  tokensOut: e.usage.output_tokens,
                }
              : {}),
          }),
        )
      })
    }
    if (agentId !== undefined && tracked.delete(agentId)) {
      const usage = {
        ...(e.usage
          ? {
              tokensIn:
                e.usage.input_tokens + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0),
              tokensOut: e.usage.output_tokens,
            }
          : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
      }
      await finishAgent($, agentId, e.answer, e.durationMs, usage)
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

  // The default view: one slim row an agent above the chat box, while there
  // are any. The engine gives the band its own [-] to collapse it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, view)) !== 'band') return next(e)
    const list = await read($, cards)
    if (list.length === 0) return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const heading = paneHeading(list)

    if (e.surface !== 'terminal' && 'Svg' in table) {
      const { Svg } = table
      const drawing = bandSvg(pixelsFor(e.props.bodyColumns), list, heading)

      return (
        <Box>
          <Svg source={drawing.source} alt={drawing.alt} />
        </Box>
      )
    }

    const width = Math.max(20, e.props.bodyColumns)
    const { shown, more } = bandCards(list)

    return (
      <Box flexDirection="column" width={width}>
        <Text color={MUTED}>{clip(`Agents · ${heading}${more > 0 ? ` · ${more} more in /skill-router pane` : ''}`, width)}</Text>
        {shown.map(card => (
          <Text key={card.id} color={colorOf(card.model)}>
            {bandLine(width, card)}
          </Text>
        ))}
      </Box>
    )
  })

  // One card a subagent, in the order they started. Desktop and the other app
  // surfaces get SVG cards; the terminal gets text rows.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const list = await read($, cards)
    const heading = paneHeading(list)

    if (e.surface !== 'terminal' && 'Svg' in table) {
      const { Svg } = table
      const px = pixelsFor(e.props.bodyColumns)

      return (
        <Box flexDirection="column">
          <Text color={MUTED}>{heading}</Text>
          {list.map(card => {
            const drawing = cardSvg(px, card)

            return (
              <Box key={card.id} marginTop={1}>
                <Svg source={drawing.source} alt={drawing.alt} />
              </Box>
            )
          })}
        </Box>
      )
    }

    const width = Math.max(20, e.props.bodyColumns)

    return (
      <Box flexDirection="column" width={width}>
        <Text color={MUTED}>{heading}</Text>
        {list.map(card => (
          <Box key={card.id} flexDirection="column" marginTop={1}>
            <Text color={colorOf(card.model)} bold>
              {clip(`${bareName(card.type)} · ${modelLabel(card.model)} · ${card.task}`, width)}
            </Text>
            <Text color={MUTED}>{clip(routeText(card), width)}</Text>
            <Text color={colorOf(card.model)}>{barText(width, card)}</Text>
            <Text color={TEXT}>{clip(statusText(card), width)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
