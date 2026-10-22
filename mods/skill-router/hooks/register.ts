import type { EngineInterface, Register } from 'claude-code'

import {
  JEV_URL,
  PINS,
  appendLog,
  bareName,
  decide,
  jevOptions,
  jevRequest,
  logLine,
  parseCount,
  parseJev,
  summary,
} from './logic'
import type { JevAnswer, LogEntry } from './logic'

type D = EngineInterface

const COMMAND = 'skill-router'
const ENABLED = 'enabled'
const LOG = 'log'

// The pick for the turn in progress. A reload mid-turn drops it, and the turn
// finishes on the session model: the safe side.
let pending: { model: string | null; entry: LogEntry } | null = null
let lastPrompt = ''
let apiKey: string | null = null

// ---------------------------------------------------------------- store

const isEnabled = async ($: D): Promise<boolean> => ((await $.store.get(ENABLED)) ?? true) === true

const readLog = async ($: D): Promise<LogEntry[]> => ((await $.store.get(LOG)) as LogEntry[] | undefined) ?? []

const writeEntry = async ($: D, entry: LogEntry) => {
  await $.store.set(LOG, appendLog(await readLog($), entry))
}

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
  skill: string,
  description: string,
  options: Parameters<typeof jevRequest>[3],
): Promise<{ answer: JevAnswer | null; ms: number; note?: string }> => {
  const started = await $.clock.now()
  const key = await readKey($)
  if (!key) return { answer: null, ms: 0, note: 'no OPENROUTER_API_KEY' }
  try {
    const response = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'skill-router' },
      body: JSON.stringify(jevRequest(skill, description, lastPrompt, options)),
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
  const asked = options ? await askJev($, skill, description, options) : undefined
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

// ---------------------------------------------------------------- command

const commandText = async ($: D, args: string): Promise<string> => {
  const [word = 'status', rest = ''] = args.trim().split(/\s+/, 2)
  if (word === 'on' || word === 'off') {
    await $.store.set(ENABLED, word === 'on')

    return `Skill router is ${word}.`
  }
  if (word === 'log') {
    const list = await readLog($)
    const lines = list.slice(-parseCount(rest, 20)).map(logLine)

    return lines.length ? [...lines, '', summary(list)].join('\n') : 'No picks logged yet.'
  }
  if (word === 'pins') return `Pinned to Haiku: ${PINS.join(', ')}.`
  if (word === 'clear') {
    await $.store.set(LOG, [])

    return 'Log cleared.'
  }
  const key = (await readKey($)) ? 'found' : 'missing'

  return [
    `Skill router is ${(await isEnabled($)) ? 'on' : 'off'}. OpenRouter key: ${key}.`,
    summary(await readLog($)),
    'Use: /skill-router on | off | status | log [n] | pins | clear',
  ].join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Skill model router: on, off, status, log, pins' })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await commandText($, e.args) })).catch(() => ({
    text: 'Skill router hit a problem reading its settings.',
  }))

  // A new prompt ends the last pick, so the session model is back.
  on('prompt.submit', ($, e, next) => {
    if (!e.isMeta) {
      pending = null
      lastPrompt = e.command ? `/${e.command.name} ${e.command.args}`.trim() : e.text
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

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
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
