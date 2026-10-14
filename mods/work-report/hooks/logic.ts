import type { DayRecord, Kind, Settings, Tab } from '../types'

// ---------------------------------------------------------------- kinds

export const KINDS: readonly Kind[] = ['emails', 'documents', 'media', 'research', 'other']

export const KIND_LABEL: Record<Kind, string> = {
  emails: 'Emails',
  documents: 'Documents',
  media: 'Images and video',
  research: 'Research',
  other: 'Other',
}

export const DEFAULT_SETTINGS: Settings = {
  rate: 50,
  minutes: { emails: 10, documents: 30, media: 20, research: 25, other: 10 },
}

// Reads whatever was kept, filling anything missing or broken with the default.
export const readSettings = (kept: unknown): Settings => {
  const out: Settings = { rate: DEFAULT_SETTINGS.rate, minutes: { ...DEFAULT_SETTINGS.minutes } }
  if (kept === null || typeof kept !== 'object') return out
  const raw = kept as { rate?: unknown; minutes?: Record<string, unknown> }
  if (typeof raw.rate === 'number' && Number.isFinite(raw.rate) && raw.rate >= 0) out.rate = raw.rate
  for (const kind of KINDS) {
    const value = raw.minutes?.[kind]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out.minutes[kind] = value
  }

  return out
}

// ---------------------------------------------------------------- what counts

// The prompts the person typed: at the terminal, in the desktop app (an SDK
// host), from the phone, or a mod sending their own words. An image sent with
// no words counts too. Slash commands, notifications, scheduled runs and other
// sessions' messages do not.
export const isTypedPrompt = (prompt: { originKind: string; asUser?: boolean; text: string; hasAttachments?: boolean }): boolean => {
  const text = prompt.text.trim()
  if (text.startsWith('/') || (text === '' && prompt.hasAttachments !== true)) return false
  if (prompt.originKind === 'plugin') return prompt.asUser === true

  return prompt.originKind === 'composer' || prompt.originKind === 'bridge' || prompt.originKind === 'sdk'
}

export type ToolUse = { tool: string; paths: string[] }

const MEDIA_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|psd|dng|cr[23]|nef|arw|raw|mp4|mov|m4v|webm|avi|mkv|prproj|aep)$/i
const DOC_FILE = /\.(docx?|pptx?|xlsx?|csv|pdf|md|markdown|txt|rtf|odt|ods|odp|pages|key|numbers)$/i
const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$|create|write|save|export|upload/i

const EMAIL_TOOL = /mail|inbox|outlook_.*draft/i
const MEDIA_TOOL =
  /image|video|photo|thumbnail|remotion|frame_?io|youtube|vidiq|firefly|premiere|blender|instagram|reel|quick_cut|animate_design|remove.background/i
const MEDIA_COMMAND = /\b(ffmpeg|ffprobe|magick|sips|remotion)\b/
const DOC_TOOL = /document|docx|pptx|xlsx|slide|presentation|spreadsheet|sheet|excel|powerpoint|word|pdf|pandadoc/i
const RESEARCH_TOOL =
  /^(WebSearch|WebFetch)$|web_?search|web_?fetch|get_page_text|read_page|transcript|fetch_url|scrape|crawl|apify|deep_research/i

// The words "password" and "keyword" are not about Word documents.
const docName = (tool: string) => tool.replace(/password|keyword/gi, '')

// One kind per task, by the tools it used. When a task used several kinds of
// tool, the first that matches in this order wins: emails, images and video,
// documents, research. A task that matched none is Other.
export const kindOf = (uses: readonly ToolUse[]): Kind => {
  // Image or video tools, saving an image or video file, or running a media
  // command. Reading, listing or merely naming an image file is not image work.
  const media = (use: ToolUse) =>
    MEDIA_TOOL.test(use.tool) ||
    (WRITES.test(use.tool) && use.paths.some(path => MEDIA_FILE.test(path))) ||
    (use.tool === 'Bash' && use.paths.some(path => MEDIA_COMMAND.test(path)))
  const documents = (use: ToolUse) =>
    DOC_TOOL.test(docName(use.tool)) || (WRITES.test(use.tool) && use.paths.some(path => DOC_FILE.test(path)))

  if (uses.some(use => EMAIL_TOOL.test(use.tool))) return 'emails'
  if (uses.some(media)) return 'media'
  if (uses.some(documents)) return 'documents'
  if (uses.some(use => RESEARCH_TOOL.test(use.tool))) return 'research'

  return 'other'
}

// The file paths a tool call names, and a shell command's text.
export const pathsOf = (input: Record<string, unknown>): string[] => {
  const found: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value === '') continue
    if (/path|file/i.test(key) || key === 'command') found.push(value.trim())
  }

  return found.slice(0, 20)
}

// "claude-opus-5-5" reads "Opus 5.5"; an id it cannot read is kept as given.
export const modelName = (id: string): string => {
  const bare = id.replace(/\[[^\]]*\]/g, '').trim()
  const older = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/i.exec(bare)
  if (older) {
    const family = older[3]!.charAt(0).toUpperCase() + older[3]!.slice(1).toLowerCase()

    return `${family} ${older[1]}${older[2] ? `.${older[2]}` : ''}`
  }
  const named = /(opus|sonnet|haiku|fable)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/i.exec(bare)
  if (named) {
    const family = named[1]!.charAt(0).toUpperCase() + named[1]!.slice(1).toLowerCase()

    return `${family} ${named[2]}${named[3] ? `.${named[3]}` : ''}`
  }

  return bare === '' ? 'Unknown model' : bare
}

// ---------------------------------------------------------------- days

const two = (n: number) => String(n).padStart(2, '0')

export const dayKey = (date: Date): string => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`

// Local noon of a day. Days are stepped from noon, so a clock change (an hour
// either way) never lands on the wrong date.
export const noonOf = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number)

  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0)
}

const DAY_MS = 86_400_000

export const addDays = (key: string, n: number): string => dayKey(new Date(noonOf(key).getTime() + n * DAY_MS))

// 1 for January 1.
export const dayOfYear = (key: string): number =>
  Math.round((noonOf(key).getTime() - noonOf(`${key.slice(0, 4)}-01-01`).getTime()) / DAY_MS) + 1

// The days a tab covers, oldest first, ending today.
export const daysOf = (tab: Tab, today: string): string[] => {
  const count = tab === 'today' ? 1 : tab === 'week' ? 7 : tab === 'month' ? 30 : dayOfYear(today)

  return Array.from({ length: count }, (_, i) => addDays(today, i - (count - 1)))
}

export const tasksOn = (day: DayRecord | undefined): number =>
  day === undefined ? 0 : KINDS.reduce((n, kind) => n + (day.kinds[kind] ?? 0), 0)

export type Totals = { tasks: number; kinds: Record<Kind, number>; models: Record<string, number> }

// Adds the records of the given days together.
export const sumDays = (days: Readonly<Record<string, DayRecord>>, keys: readonly string[]): Totals => {
  const kinds: Record<Kind, number> = { emails: 0, documents: 0, media: 0, research: 0, other: 0 }
  const models: Record<string, number> = {}
  for (const key of keys) {
    const day = days[key]
    if (day === undefined) continue
    for (const kind of KINDS) kinds[kind] += day.kinds[kind] ?? 0
    for (const [model, n] of Object.entries(day.models)) models[model] = (models[model] ?? 0) + n
  }

  return { tasks: KINDS.reduce((n, kind) => n + kinds[kind], 0), kinds, models }
}

// One finished task added to a day's record.
export const addTask = (day: DayRecord | undefined, kind: Kind, model: string): DayRecord => ({
  kinds: { ...(day?.kinds ?? {}), [kind]: (day?.kinds[kind] ?? 0) + 1 },
  models: { ...(day?.models ?? {}), [model]: (day?.models[model] ?? 0) + 1 },
})

// Reads a kept day, dropping anything that is not a count.
export const readDay = (kept: unknown): DayRecord | undefined => {
  if (kept === null || typeof kept !== 'object') return undefined
  const raw = kept as { kinds?: Record<string, unknown>; models?: Record<string, unknown> }
  const day: DayRecord = { kinds: {}, models: {} }
  for (const kind of KINDS) {
    const n = raw.kinds?.[kind]
    if (typeof n === 'number' && n > 0) day.kinds[kind] = Math.round(n)
  }
  for (const [model, n] of Object.entries(raw.models ?? {})) {
    if (typeof n === 'number' && n > 0) day.models[model] = Math.round(n)
  }

  return day
}

// Days in a row with at least one task, ending today. A day with nothing yet
// does not break the streak until it is over, so the count runs to yesterday.
export const streak = (days: Readonly<Record<string, DayRecord>>, today: string): number => {
  let key = tasksOn(days[today]) > 0 ? today : addDays(today, -1)
  let n = 0
  while (tasksOn(days[key]) > 0 && n < 3700) {
    n += 1
    key = addDays(key, -1)
  }

  return n
}

// ---------------------------------------------------------------- the estimate

export const minutesSaved = (kinds: Readonly<Record<Kind, number>>, settings: Settings): number =>
  KINDS.reduce((n, kind) => n + kinds[kind] * settings.minutes[kind], 0)

// 0.4, 2.5, 12, 140: one decimal below ten, whole hours after.
export const hoursText = (minutes: number): string => {
  const hours = minutes / 60
  if (hours === 0) return '0'
  if (hours < 10) return String(Math.round(hours * 10) / 10)

  return String(Math.round(hours))
}

export const moneyText = (minutes: number, rate: number, commas = false): string => {
  const dollars = Math.round((minutes / 60) * rate)

  return `$${commas ? dollars.toLocaleString('en-US') : String(dollars)}`
}

// ---------------------------------------------------------------- titles

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const shortDate = (key: string): string => {
  const date = noonOf(key)

  return `${MONTHS[date.getMonth()]!.slice(0, 3)} ${date.getDate()}`
}

export const titleOf = (tab: Tab, today: string): { name: string; dates: string } => {
  const first = daysOf(tab, today)[0] ?? today
  if (tab === 'today') return { name: 'TODAY', dates: `${WEEKDAYS[noonOf(today).getDay()]}, ${shortDate(today)}` }
  if (tab === 'week') return { name: 'LAST 7 DAYS', dates: `${shortDate(first)} to ${shortDate(today)}` }
  if (tab === 'month') return { name: 'LAST 30 DAYS', dates: `${shortDate(first)} to ${shortDate(today)}` }

  return { name: `${today.slice(0, 4)} SO FAR`, dates: `Jan 1 to ${shortDate(today)}` }
}

export const emptyText = (tab: Tab): string =>
  tab === 'today'
    ? 'Nothing finished yet today. Your first finished task shows up here.'
    : tab === 'week'
      ? 'Nothing finished in the last 7 days. Your first finished task shows up here.'
      : tab === 'month'
        ? 'Nothing finished in the last 30 days. Your first finished task shows up here.'
        : 'Nothing finished this year. Your first finished task shows up here.'

// ---------------------------------------------------------------- the chart

export type Bar = { label: string; value: number; isCurrent: boolean; isFuture: boolean }

// Today and Week: the last seven days by weekday. Month: thirty daily bars.
// Year: January through December, the months still to come left empty.
export const barsOf = (tab: Tab, days: Readonly<Record<string, DayRecord>>, today: string): Bar[] => {
  if (tab === 'today' || tab === 'week' || tab === 'month') {
    return daysOf(tab === 'month' ? 'month' : 'week', today).map(key => ({
      label: WEEKDAYS[noonOf(key).getDay()]!.slice(0, 2),
      value: tasksOn(days[key]),
      isCurrent: key === today,
      isFuture: false,
    }))
  }
  const year = today.slice(0, 4)
  const month = Number(today.slice(5, 7))

  return MONTHS.map((name, i) => ({
    label: name.charAt(0),
    value: Object.entries(days)
      .filter(([key]) => key.startsWith(`${year}-${two(i + 1)}-`))
      .reduce((n, [, day]) => n + tasksOn(day), 0),
    isCurrent: i + 1 === month,
    isFuture: i + 1 > month,
  }))
}

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// One character per bar per row, top row first: three rows, 24 steps.
export const barCells = (value: number, max: number): [string, string, string] => {
  const steps = max <= 0 || value <= 0 ? 0 : Math.max(1, Math.round((value / max) * 24))
  const cell = (row: number) => EIGHTHS[Math.max(0, Math.min(8, steps - row * 8))]!

  return [cell(2), cell(1), cell(0)]
}

// The line under the chart.
export const summaryOf = (tab: Tab, days: Readonly<Record<string, DayRecord>>, today: string): string => {
  if (tab === 'today' || tab === 'week') {
    const n = streak(days, today)
    if (n === 0) return 'No streak yet. Finish a task today to start one.'

    return n === 1 ? 'Streak: 1 day.' : `Streak: ${n} days in a row.`
  }
  const keys = daysOf(tab, today)
  const active = keys.filter(key => tasksOn(days[key]) > 0).length
  const activeText = active === 1 ? '1 active day' : `${active} active days`
  if (active === 0) return 'No active days yet.'

  if (tab === 'month') {
    const best = keys.reduce((a, b) => (tasksOn(days[b]) >= tasksOn(days[a]) ? b : a))
    const n = tasksOn(days[best])

    return `Best day ${shortDate(best)}, ${n} ${n === 1 ? 'task' : 'tasks'}. ${activeText}.`
  }
  const bars = barsOf('year', days, today)
  const best = bars.reduce((a, b) => (b.value >= a.value ? b : a))
  const index = bars.indexOf(best)

  return `Best month ${MONTHS[index]}, ${best.value} ${best.value === 1 ? 'task' : 'tasks'}. ${activeText}.`
}

// ---------------------------------------------------------------- settings

const SETTING_NAMES: Record<string, 'rate' | Kind> = {
  rate: 'rate',
  hourly: 'rate',
  email: 'emails',
  emails: 'emails',
  document: 'documents',
  documents: 'documents',
  docs: 'documents',
  image: 'media',
  images: 'media',
  video: 'media',
  media: 'media',
  research: 'research',
  other: 'other',
}

export const settingsText = (settings: Settings): string =>
  [
    'Work Report settings. Hours and dollars are estimates.',
    `  Hourly rate: $${settings.rate}`,
    `  Minutes saved per task: ${KINDS.map(kind => `${KIND_LABEL[kind]} ${settings.minutes[kind]}`).join(', ')}`,
    'Change one with /report settings rate 75 or /report settings emails 15.',
    'Names: rate, emails, documents, images, research, other.',
  ].join('\n')

// `/report settings ...`: lists them, or changes one and says what changed.
export const applySetting = (args: string, settings: Settings): { settings?: Settings; text: string } => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { text: settingsText(settings) }

  const name = SETTING_NAMES[words[0]!.toLowerCase()]
  if (name === undefined) {
    return { text: `There is no setting called "${words[0]}". Use rate, emails, documents, images, research or other.` }
  }
  const raw = (words[1] ?? '').replace(/^\$/, '')
  const value = Number(raw)
  const cap = name === 'rate' ? 10000 : 480
  if (raw === '' || !Number.isFinite(value) || value < 0 || value > cap) {
    return {
      text:
        name === 'rate'
          ? 'Give the hourly rate as a number from 0 to 10000, like /report settings rate 75.'
          : `Give the minutes as a number from 0 to 480, like /report settings ${words[0]!.toLowerCase()} 15.`,
    }
  }
  const rounded = Math.round(value * 100) / 100

  if (name === 'rate') {
    return { settings: { ...settings, rate: rounded }, text: `Hourly rate is now $${rounded}. The report uses it from now on, for every day.` }
  }

  return {
    settings: { ...settings, minutes: { ...settings.minutes, [name]: rounded } },
    text: `${KIND_LABEL[name]} now count as ${rounded} minutes saved per task, for every day.`,
  }
}

// ---------------------------------------------------------------- drawing helpers

export const clip = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

// Breaks text into lines no wider than `width`, so nothing is left to wrap.
export const wrap = (text: string, width: number): string[] => {
  const room = Math.max(1, width)
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > room) {
      if (line !== '') lines.push(line)
      line = ''
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
  if (line !== '') lines.push(line)

  return lines
}

// Characters three rows tall in heavy box-drawing strokes.
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
  '.': [' ', ' ', '▪'],
  $: ['┏╋╸', '┗╋┓', '╺╋┛'],
}

export const bigText = (text: string): [string, string, string] => {
  const chars = text.split('').filter(char => GLYPHS[char] !== undefined)
  const rows: [string, string, string] = ['', '', '']
  for (const row of [0, 1, 2] as const) rows[row] = chars.map(char => GLYPHS[char]![row]).join(' ')

  return rows
}

// How many tiles sit side by side: three, then two, then one.
export const tilesPerRow = (width: number, widest: number, count = 3): number => {
  for (let n = count; n > 1; n--) {
    if (n * widest + (n - 1) <= width) return n
  }

  return 1
}

// ---------------------------------------------------------------- history

// One finished request as scripts/history.py prints it.
export type PastTask = { t: number; m: string; u: [string, string[]][] }

export const readHistory = (text: string): PastTask[] => {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) return []

  return raw.filter(
    (task): task is PastTask =>
      typeof task === 'object' && task !== null && typeof task.t === 'number' && typeof task.m === 'string' && Array.isArray(task.u),
  )
}

// The past requests counted into day records, sorted and named as live ones are.
export const historyDays = (tasks: readonly PastTask[]): Record<string, DayRecord> => {
  const days: Record<string, DayRecord> = {}
  for (const task of tasks) {
    const key = dayKey(new Date(task.t))
    const uses = task.u.map(([tool, paths]) => ({ tool: String(tool), paths: Array.isArray(paths) ? paths.map(String) : [] }))
    days[key] = addTask(days[key], kindOf(uses), modelName(task.m))
  }

  return days
}
