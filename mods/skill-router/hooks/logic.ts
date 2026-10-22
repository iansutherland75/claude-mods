// Pure parts of skill-router: the pin list, the Jev request and answer, the
// decision, and the log. No `$` here, so the tests run it directly.

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

export type Source = 'pin' | 'jev' | 'kept'

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

// ---------------------------------------------------------------- log

export type LogEntry = {
  at: number
  skill: string
  session: string
  source: Source
  pick: Tier | null
  switched: boolean
  probability?: number
  jevMs?: number
  jevCost?: number
  note?: string
  turnMs?: number
  tokensIn?: number
  tokensOut?: number
}

export const appendLog = (list: readonly LogEntry[], entry: LogEntry): LogEntry[] => [...list, entry].slice(-LOG_LIMIT)

const shortModel = (model: string): string => tierOf(model) ?? model

const stamp = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const logLine = (e: LogEntry): string => {
  const route = e.switched ? `${shortModel(e.session)} → ${e.pick}` : `stayed ${shortModel(e.session)}`
  const parts = [stamp(e.at), bareName(e.skill), e.source, route]
  if (e.probability !== undefined) parts.push(`p ${e.probability.toFixed(2)}`)
  if (e.jevMs !== undefined) parts.push(`Jev ${e.jevMs} ms`)
  if (e.jevCost !== undefined) parts.push(`$${e.jevCost.toFixed(6)}`)
  if (e.turnMs !== undefined) parts.push(`turn ${(e.turnMs / 1000).toFixed(1)} s`)
  if (e.tokensIn !== undefined) parts.push(`${e.tokensIn} in / ${e.tokensOut ?? 0} out`)
  if (e.note) parts.push(e.note)

  return parts.join(' · ')
}

export const summary = (list: readonly LogEntry[]): string => {
  const count = (source: Source) => list.filter(e => e.source === source).length
  const cost = list.reduce((sum, e) => sum + (e.jevCost ?? 0), 0)
  const switched = list.filter(e => e.switched).length

  return `${list.length} picks: ${count('pin')} pinned, ${count('jev')} by Jev, ${count('kept')} kept. ${switched} switched model. Jev cost $${cost.toFixed(6)}.`
}

export const parseCount = (args: string, fallback: number): number => {
  const n = Number.parseInt(args, 10)

  return Number.isFinite(n) && n > 0 ? Math.min(n, LOG_LIMIT) : fallback
}
