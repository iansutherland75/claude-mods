// Pure helpers: no `$`, no state. Shared by the hooks module and the tests.

import type { Answer, Question } from '../types'

export const QUESTION_MODEL = 'haiku'
export const REWRITE_MODEL = 'sonnet'

// What the prompt box hands us, reduced to what the intercept rules read.
export type Submitted = {
  text: string
  originKind: string
  hasAttachments: boolean
  isMidTurn: boolean
}

export type Decision =
  | { kind: 'pass' }
  | { kind: 'strip'; text: string }
  | { kind: 'intercept' }

const SHORT_REPLIES = new Set([
  'y', 'n', 'yes', 'no', 'yep', 'yeah', 'nope', 'ok', 'okay', 'k', 'sure',
  'thanks', 'thank you', 'ty', 'cool', 'great', 'nice', 'perfect', 'done',
  'continue', 'keep going', 'go on', 'go ahead', 'do it', 'proceed', 'next',
  'stop', 'wait', 'carry on', 'sounds good', 'looks good', 'lgtm', 'yes please',
  'no thanks', 'ship it', 'try again', 'again', 'retry', 'undo', 'revert',
])

export const wordCount = (text: string): number =>
  text.trim().split(/\s+/).filter(Boolean).length

export const isShortReply = (text: string): boolean => {
  const plain = text.trim().toLowerCase().replace(/[.!?,;:]+$/g, '').trim()

  return SHORT_REPLIES.has(plain) || wordCount(plain) <= 2
}

// Which prompts the automatic mode sends to the pane, and which go straight
// through. `hasOpenFlow` is true while an upgrade is already in the pane.
export const classify = (
  sent: Submitted,
  isAuto: boolean,
  hasOpenFlow: boolean,
): Decision => {
  if (!isAuto || sent.originKind !== 'composer') return { kind: 'pass' }

  const text = sent.text.trim()

  if (text.startsWith('>')) return { kind: 'strip', text: text.slice(1).trimStart() }
  if (text.startsWith('/')) return { kind: 'pass' }
  if (sent.hasAttachments || sent.isMidTurn) return { kind: 'pass' }
  if (text === '' || isShortReply(text)) return { kind: 'pass' }
  if (hasOpenFlow) return { kind: 'pass' }

  return { kind: 'intercept' }
}

// The first JSON object in a model reply, fences and stray prose allowed.
export const extractJson = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const asText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

// Up to three questions of two to four options each; [] when none would help,
// null when the reply could not be read at all.
export const parseQuestions = (text: string): Question[] | null => {
  const data = extractJson(text)
  if (typeof data !== 'object' || data === null) return null
  const list = (data as { questions?: unknown }).questions
  if (!Array.isArray(list)) return null

  const questions: Question[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as { question?: unknown; q?: unknown; options?: unknown }
    const question = asText(raw.question ?? raw.q, 160)
    const options = Array.isArray(raw.options)
      ? [...new Set(raw.options.map(one => asText(one, 40)).filter(Boolean))].slice(0, 4)
      : []
    if (question !== '' && options.length >= 2) questions.push({ question, options })
    if (questions.length === 3) break
  }

  return questions
}

export type Rewrite = { prompt: string; added: string[] }

export const parseRewrite = (text: string): Rewrite | null => {
  const data = extractJson(text)
  if (typeof data === 'object' && data !== null) {
    const raw = data as { prompt?: unknown; added?: unknown }
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    if (prompt !== '') {
      const added = Array.isArray(raw.added)
        ? raw.added.map(one => asText(one, 120)).filter(Boolean).slice(0, 6)
        : []

      return { prompt, added }
    }

    return null
  }

  const plain = text.trim()

  return plain === '' ? null : { prompt: plain, added: [] }
}

export const QUESTION_SYSTEM = [
  'You help a person improve a rough prompt before they send it to Claude, an AI assistant that can also work in their files and tools.',
  'Ask at most three multiple-choice questions: the ones whose answers would most improve the result.',
  'Each question is under 12 words. Each has two to four options of one to five words.',
  'Do not ask for things only the person can type, such as names, numbers or prices.',
  'If no question would clearly help, ask none.',
  'Reply with JSON only, no other text, in this shape: {"questions":[{"question":"...","options":["...","..."]}]}',
  'With no questions, reply {"questions":[]}',
].join('\n')

export const questionPrompt = (original: string): string =>
  `The rough prompt:\n<prompt>\n${original}\n</prompt>`

export const REWRITE_SYSTEM = [
  "You rewrite a person's rough prompt into a clear one before they send it to Claude.",
  'Rules:',
  '- Keep exactly what they meant. Do not change the task.',
  '- Add a clear goal, who the result is for, the format, and what done looks like.',
  '- Use their answers. Leave out anything they skipped.',
  '- Never invent facts, names, numbers, prices, dates or file names. Where something needed is unknown, leave a placeholder in square brackets, like [audience] or [deadline].',
  '- Write it as one request they could have typed themselves, in plain language, in the first person.',
  'Reply with JSON only, no other text, in this shape: {"prompt":"the upgraded prompt","added":["a short note for each thing you added"]}',
  'Keep each note under 10 words. At most six notes.',
].join('\n')

export const answerText = (answer: Answer | null | undefined): string | null =>
  answer === null || answer === undefined || answer.kind === 'skip' ? null : answer.text

export const rewritePrompt = (
  original: string,
  questions: readonly Question[],
  answers: readonly (Answer | null)[],
): string => {
  const lines = questions.flatMap((one, i) => {
    const text = answerText(answers[i])

    return text === null ? [] : [`- ${one.question} ${text}`]
  })

  return [
    `The rough prompt:\n<prompt>\n${original}\n</prompt>`,
    lines.length === 0 ? 'They answered no questions.' : `Their answers:\n${lines.join('\n')}`,
  ].join('\n\n')
}

export type Failure =
  | { reason: 'api-error'; status: number | null; error: string }
  | { reason: 'empty-reply' }
  | { reason: 'aborted' }
  | { reason: string }

export const describeFailure = (failure: Failure): string => {
  if (failure.reason === 'aborted') return 'The model took too long to answer.'
  if (failure.reason === 'empty-reply') return 'The model sent back an empty reply.'
  if (failure.reason === 'api-error' && 'error' in failure) {
    if (failure.error === 'rate_limit') return 'The model is rate limited right now.'
    if (failure.error === 'overloaded') return 'The model is overloaded right now.'
    if (failure.error === 'authentication_failed') return 'The model call was not signed in.'

    return `The model call failed (${failure.status ?? 'no response'}).`
  }

  return 'The model call failed.'
}

// Word wrap to an exact width: every line it returns fits in `width` cells.
export const wrap = (text: string, width: number): string[] => {
  const room = Math.max(1, width)
  const lines: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word
      while (rest.length > room) {
        if (line !== '') {
          lines.push(line)
          line = ''
        }
        lines.push(rest.slice(0, room))
        rest = rest.slice(room)
      }
      if (line === '') line = rest
      else if (line.length + 1 + rest.length <= room) line = `${line} ${rest}`
      else {
        lines.push(line)
        line = rest
      }
    }
    lines.push(line)
  }

  return lines
}

export const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

// Digits three rows tall in heavy box-drawing strokes.
const GLYPHS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

export const bigNumber = (value: number): [string, string, string] => {
  const digits = String(Math.max(0, Math.round(value))).split('')
  const rows: [string, string, string] = ['', '', '']
  for (const row of [0, 1, 2] as const) {
    rows[row] = digits.map(d => (GLYPHS[d] ?? GLYPHS['0']!)[row]).join(' ')
  }

  return rows
}

// Lays chips out in rows that each fit `width`, `gap` cells apart.
export const chipRows = <T>(items: readonly T[], widthOf: (item: T) => number, width: number, gap = 1): T[][] => {
  const rows: T[][] = []
  let row: T[] = []
  let used = 0
  for (const item of items) {
    const w = widthOf(item)
    if (row.length > 0 && used + gap + w > width) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length > 0 ? gap : 0) + w
    row.push(item)
  }
  if (row.length > 0) rows.push(row)

  return rows
}

export const STEPS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const

// The tracker line's parts at a width: full labels when they fit, else the
// current label alone, else numbers.
export const trackerParts = (current: number, width: number): { mark: string; label: string; state: 'done' | 'now' | 'todo' }[] => {
  const state = (i: number) => (i < current ? 'done' : i === current ? 'now' : 'todo') as 'done' | 'now' | 'todo'
  const mark = (i: number) => (i < current ? '✓' : i === current ? '●' : '○')
  const build = (labelOf: (i: number) => string) =>
    STEPS.map((_, i) => ({ mark: mark(i), label: labelOf(i), state: state(i) }))
  const size = (parts: { mark: string; label: string }[]) =>
    parts.reduce((n, p) => n + p.mark.length + (p.label ? 1 + p.label.length : 0), 0) + (parts.length - 1) * 4

  const full = build(i => STEPS[i] ?? '')
  if (size(full) <= width) return full
  const focused = build(i => (i === current ? (STEPS[i] ?? '') : String(i + 1)))
  if (size(focused) <= width) return focused

  return build(i => String(i + 1))
}
