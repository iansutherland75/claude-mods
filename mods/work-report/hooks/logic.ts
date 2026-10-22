import type { DayRecord, Kind, ManualEntry, ProjectDay, Settings, Tab } from '../types'

// ---------------------------------------------------------------- kinds

export const KINDS: readonly Kind[] = ['emails', 'documents', 'building', 'media', 'research', 'other']

export const KIND_LABEL: Record<Kind, string> = {
  emails: 'Emails',
  documents: 'Documents',
  building: 'Building software',
  media: 'Images and video',
  research: 'Research',
  other: 'Other',
}

// Building is sized by the code it wrote: lines divided by buildRate (lines an
// hour), and never less than minutes.building per task.
export const DEFAULT_SETTINGS: Settings = {
  rate: 50,
  minutes: { emails: 10, documents: 30, building: 30, media: 20, research: 25, other: 10 },
  buildRate: 25,
}

// Reads whatever was kept, filling anything missing or broken with the default.
export const readSettings = (kept: unknown): Settings => {
  const out: Settings = { rate: DEFAULT_SETTINGS.rate, minutes: { ...DEFAULT_SETTINGS.minutes }, buildRate: DEFAULT_SETTINGS.buildRate }
  if (kept === null || typeof kept !== 'object') return out
  const raw = kept as { rate?: unknown; minutes?: Record<string, unknown>; buildRate?: unknown }
  if (typeof raw.rate === 'number' && Number.isFinite(raw.rate) && raw.rate >= 0) out.rate = raw.rate
  if (typeof raw.buildRate === 'number' && Number.isFinite(raw.buildRate) && raw.buildRate > 0) out.buildRate = raw.buildRate
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

// A tool call as the sorting reads it: its name, the paths (or shell command)
// it names, and how many lines of text it wrote, for a tool that writes.
export type ToolUse = { tool: string; paths: string[]; lines?: number }

const MEDIA_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg|psd|dng|cr[23]|nef|arw|raw|mp4|mov|m4v|webm|avi|mkv|prproj|aep)$/i
const DOC_FILE = /\.(docx?|pptx?|xlsx?|csv|pdf|md|markdown|txt|rtf|odt|ods|odp|pages|key|numbers)$/i
const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$|create|write|save|export|upload/i
const FILE_WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$/
export const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|cs|php|sh|zsh|bash|ps1|psm1|sql|html?|css|scss|less|vue|svelte|json|jsonc|ya?ml|toml|ini|ipynb)$/i
const BUILD_COMMAND =
  /\b(npm|npx|pnpm|yarn|bun|node|deno|wrangler|pytest|vitest|jest|tsc|docker|az|terraform|pip3?|uv|cargo|go (build|test|run)|git (commit|push)|gh (pr|repo|release)|claude plugin|(?:python3?|py) [\w./\\:-]+\.py)\b/
// Remotion projects are video production, whatever the file type.
const REMOTION_PATH = /remotion/i

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
// building software, documents, research. A task that matched none is Other.
export const kindOf = (uses: readonly ToolUse[]): Kind => {
  // Image or video tools, saving an image or video file, or running a media
  // command. Reading, listing or merely naming an image file is not image work.
  const media = (use: ToolUse) =>
    MEDIA_TOOL.test(use.tool) ||
    (WRITES.test(use.tool) && use.paths.some(path => MEDIA_FILE.test(path))) ||
    (use.tool === 'Bash' && use.paths.some(path => MEDIA_COMMAND.test(path))) ||
    (FILE_WRITES.test(use.tool) && use.paths.some(path => REMOTION_PATH.test(path)))
  // Writing code, or running a build, test or deploy command.
  const building = (use: ToolUse) =>
    (FILE_WRITES.test(use.tool) && use.paths.some(path => CODE_FILE.test(path))) ||
    (use.tool === 'Bash' && use.paths.some(path => BUILD_COMMAND.test(path)))
  const documents = (use: ToolUse) =>
    DOC_TOOL.test(docName(use.tool)) || (WRITES.test(use.tool) && use.paths.some(path => DOC_FILE.test(path)))

  if (uses.some(use => EMAIL_TOOL.test(use.tool))) return 'emails'
  if (uses.some(media)) return 'media'
  if (uses.some(building)) return 'building'
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

// How many lines a writing tool's input writes: a new file's content, an
// edit's replacement text, each edit of a multi-edit, a notebook cell.
export const writtenLines = (input: Record<string, unknown>): number => {
  const count = (text: unknown) => (typeof text === 'string' && text !== '' ? text.split('\n').length : 0)
  const edits = Array.isArray(input.edits) ? (input.edits as { new_string?: unknown }[]) : []

  return count(input.content) + count(input.new_string) + count(input.new_source) + edits.reduce((n, edit) => n + count(edit?.new_string), 0)
}

// The lines of code a task wrote: a file written whole counts its last
// version once; edits add their new lines. Files that are not code, and
// Remotion video projects, count nothing.
export const taskLines = (uses: readonly ToolUse[]): number => {
  const whole = new Map<string, number>()
  const edited = new Map<string, number>()
  for (const use of uses) {
    if (!FILE_WRITES.test(use.tool)) continue
    const file = use.paths.find(path => CODE_FILE.test(path) && !REMOTION_PATH.test(path))
    if (file === undefined) continue
    const lines = Math.max(0, Math.round(use.lines ?? 0))
    if (use.tool === 'Write') {
      whole.set(file, lines)
      edited.delete(file)
    } else edited.set(file, (edited.get(file) ?? 0) + lines)
  }

  return [...whole.values(), ...edited.values()].reduce((n, lines) => n + lines, 0)
}

// Windows paths arrive as C:\Users\name\... ; every rule below reads them
// with forward slashes.
const slashed = (path: string) => path.replace(/\\/g, '/')
const WIN_DRIVE = /^[A-Za-z]:(?:\/|$)/

export const isAbsolutePath = (path: string) => slashed(path).startsWith('/') || WIN_DRIVE.test(slashed(path))

// A folder on a Windows drive: under home, the dev root at the drive's top
// (D:\dev\<repo>), another top folder, or Users\<name>\<folder>.
const windowsProject = (path: string, base: string): string => {
  const low = path.toLowerCase()
  const home = base.toLowerCase()
  if (home !== '' && low === home) return 'home folder'
  if (home !== '' && low.startsWith(`${home}/`)) return path.slice(base.length + 1).split('/')[0]!
  const dev = /^[A-Za-z]:\/dev(?:\/([^/]+))?/i.exec(path)
  if (dev) return dev[1] ?? 'dev workspace'
  const user = /^[A-Za-z]:\/Users\/[^/]+\/([^/]+)/i.exec(path)
  if (user) return user[1]!
  const top = /^[A-Za-z]:\/([^/]+)/.exec(path)

  return top ? top[1]! : 'unknown'
}

// The project a session works in, named by its folder: the repo under a dev
// root (/Volumes/<drive>/dev/<repo>), a top folder on another drive, or the
// first folder under home. Windows paths follow the same rules.
export const projectOf = (cwd: string, home = ''): string => {
  const path = slashed(cwd).replace(/\/+$/, '')
  const base = slashed(home).replace(/\/+$/, '')
  if (WIN_DRIVE.test(path)) return windowsProject(path, base)
  const dev = /^\/Volumes\/[^/]+\/dev(?:\/([^/]+))?/.exec(path)
  if (dev) return dev[1] ?? 'dev workspace'
  const drive = /^\/Volumes\/[^/]+\/([^/]+)/.exec(path)
  if (drive) return drive[1]!
  if (base !== '' && path === base) return 'home folder'
  if (base !== '' && path.startsWith(`${base}/`)) return path.slice(base.length + 1).split('/')[0]!

  return path.split('/').pop() || 'unknown'
}

// A task's project: where most of the files it wrote live, else the folder
// it ran in. A session started at the dev root that builds inside one repo
// counts toward that repo. Mods under construction count toward claude-mods.
export const projectOfTask = (cwd: string, uses: readonly ToolUse[], home = ''): string => {
  const tally = new Map<string, number>()
  for (const use of uses) {
    if (!FILE_WRITES.test(use.tool)) continue
    for (const written of use.paths) {
      if (!isAbsolutePath(written)) continue
      const path = slashed(written)
      // Mods under construction belong to claude-mods; scratch files, temp
      // folders and Claude's own notes and settings belong to no project.
      if (/\/\.claude\/dev-mods\//.test(path)) {
        tally.set('claude-mods', (tally.get('claude-mods') ?? 0) + 1)
        continue
      }
      if (/^\/(private|tmp|var)\/|\/Library\/|\/\.claude\//.test(path) || /^[A-Za-z]:\/(Windows|Temp|tmp)\/|\/AppData\//i.test(path)) continue
      const name = projectOf(path.replace(/\/[^/]*$/, ''), home)
      tally.set(name, (tally.get(name) ?? 0) + 1)
    }
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]

  return best !== undefined ? best[0] : projectOf(cwd, home)
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

// What an estimate is worked out from: tasks of each kind, the lines each
// Building task wrote, and hours added by hand.
export type Bucket = { kinds: Record<Kind, number>; buildLines: number[]; manualMinutes: number }

export type Totals = Bucket & {
  tasks: number
  models: Record<string, number>
  projects: Record<string, Bucket & { tasks: number }>
}

const emptyKinds = (): Record<Kind, number> => ({ emails: 0, documents: 0, building: 0, media: 0, research: 0, other: 0 })

const addInto = (bucket: Bucket, kinds: Partial<Record<Kind, number>>, buildLines: readonly number[] | undefined) => {
  for (const kind of KINDS) bucket.kinds[kind] += kinds[kind] ?? 0
  if (buildLines) bucket.buildLines.push(...buildLines)
}

// Adds the records of the given days together, with any hours added by hand
// on those days.
export const sumDays = (
  days: Readonly<Record<string, DayRecord>>,
  keys: readonly string[],
  manual: readonly ManualEntry[] = [],
): Totals => {
  const totals: Totals = { kinds: emptyKinds(), buildLines: [], manualMinutes: 0, tasks: 0, models: {}, projects: {} }
  const project = (name: string) =>
    (totals.projects[name] ??= { kinds: emptyKinds(), buildLines: [], manualMinutes: 0, tasks: 0 })
  const inRange = new Set(keys)
  for (const key of keys) {
    const day = days[key]
    if (day === undefined) continue
    addInto(totals, day.kinds, day.buildLines)
    for (const [model, n] of Object.entries(day.models)) totals.models[model] = (totals.models[model] ?? 0) + n
    for (const [name, share] of Object.entries(day.projects ?? {})) {
      const one = project(name)
      addInto(one, share.kinds, share.buildLines)
      one.tasks += KINDS.reduce((n, kind) => n + (share.kinds[kind] ?? 0), 0)
    }
  }
  for (const entry of manual) {
    if (!inRange.has(entry.date)) continue
    totals.manualMinutes += entry.hours * 60
    project(entry.project).manualMinutes += entry.hours * 60
  }
  totals.tasks = KINDS.reduce((n, kind) => n + totals.kinds[kind], 0)

  return totals
}

// One finished task added to a day's record, and to its project's share.
export const addTask = (day: DayRecord | undefined, kind: Kind, model: string, project?: string, lines = 0): DayRecord => {
  const next: DayRecord = {
    kinds: { ...(day?.kinds ?? {}), [kind]: (day?.kinds[kind] ?? 0) + 1 },
    models: { ...(day?.models ?? {}), [model]: (day?.models[model] ?? 0) + 1 },
  }
  const buildLines = kind === 'building' ? [...(day?.buildLines ?? []), Math.max(0, Math.round(lines))] : day?.buildLines
  if (buildLines !== undefined && buildLines.length > 0) next.buildLines = buildLines
  const projects = { ...(day?.projects ?? {}) }
  if (project !== undefined && project !== '') {
    const share: ProjectDay = projects[project] ?? { kinds: {} }
    projects[project] = {
      kinds: { ...share.kinds, [kind]: (share.kinds[kind] ?? 0) + 1 },
      ...(kind === 'building'
        ? { buildLines: [...(share.buildLines ?? []), Math.max(0, Math.round(lines))] }
        : share.buildLines
          ? { buildLines: share.buildLines }
          : {}),
    }
  }
  if (Object.keys(projects).length > 0) next.projects = projects

  return next
}

const readCounts = (raw: Record<string, unknown> | undefined): Partial<Record<Kind, number>> => {
  const kinds: Partial<Record<Kind, number>> = {}
  for (const kind of KINDS) {
    const n = raw?.[kind]
    if (typeof n === 'number' && n > 0) kinds[kind] = Math.round(n)
  }

  return kinds
}

const readLines = (raw: unknown): number[] | undefined =>
  Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number' && n >= 0).map(Math.round) : undefined

// Reads a kept day, dropping anything that is not a count.
export const readDay = (kept: unknown): DayRecord | undefined => {
  if (kept === null || typeof kept !== 'object') return undefined
  const raw = kept as { kinds?: Record<string, unknown>; models?: Record<string, unknown>; buildLines?: unknown; projects?: Record<string, unknown> }
  const day: DayRecord = { kinds: readCounts(raw.kinds), models: {} }
  for (const [model, n] of Object.entries(raw.models ?? {})) {
    if (typeof n === 'number' && n > 0) day.models[model] = Math.round(n)
  }
  const buildLines = readLines(raw.buildLines)
  if (buildLines && buildLines.length > 0) day.buildLines = buildLines
  const projects: Record<string, ProjectDay> = {}
  for (const [name, share] of Object.entries(raw.projects ?? {})) {
    if (share === null || typeof share !== 'object') continue
    const one = share as { kinds?: Record<string, unknown>; buildLines?: unknown }
    const lines = readLines(one.buildLines)
    projects[name] = { kinds: readCounts(one.kinds), ...(lines && lines.length > 0 ? { buildLines: lines } : {}) }
  }
  if (Object.keys(projects).length > 0) day.projects = projects

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

// One kind's estimated minutes. Building is sized by the lines each task
// wrote, never under the floor; the other kinds are flat minutes per task.
export const kindMinutes = (bucket: Bucket, kind: Kind, settings: Settings): number => {
  if (kind !== 'building') return bucket.kinds[kind] * settings.minutes[kind]
  const floor = settings.minutes.building
  const sized = bucket.buildLines.reduce((n, lines) => n + Math.max(floor, (lines / settings.buildRate) * 60), 0)
  // Tasks counted before lines were recorded get the floor.
  const unsized = Math.max(0, bucket.kinds.building - bucket.buildLines.length)

  return sized + unsized * floor
}

// Everything in a bucket, hours added by hand included.
export const minutesSaved = (bucket: Bucket, settings: Settings): number =>
  KINDS.reduce((n, kind) => n + kindMinutes(bucket, kind, settings), 0) + bucket.manualMinutes

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

const SETTING_NAMES: Record<string, 'rate' | 'buildRate' | Kind> = {
  rate: 'rate',
  hourly: 'rate',
  email: 'emails',
  emails: 'emails',
  document: 'documents',
  documents: 'documents',
  docs: 'documents',
  building: 'building',
  build: 'building',
  code: 'building',
  buildrate: 'buildRate',
  lines: 'buildRate',
  image: 'media',
  images: 'media',
  video: 'media',
  media: 'media',
  research: 'research',
  other: 'other',
}

const NAMES_TEXT = 'rate, buildrate, emails, documents, building, images, research, other'

export const settingsText = (settings: Settings): string =>
  [
    'Work Report settings. Hours and dollars are estimates.',
    `  Hourly rate: $${settings.rate}`,
    `  Minutes saved per task: ${KINDS.filter(kind => kind !== 'building').map(kind => `${KIND_LABEL[kind]} ${settings.minutes[kind]}`).join(', ')}`,
    `  Building software: lines of code written ÷ ${settings.buildRate} an hour, at least ${settings.minutes.building} minutes a task`,
    'Change one with /report settings rate 75, /report settings emails 15 or /report settings buildrate 40.',
    `Names: ${NAMES_TEXT}.`,
  ].join('\n')

// `/report settings ...`: lists them, or changes one and says what changed.
export const applySetting = (args: string, settings: Settings): { settings?: Settings; text: string } => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { text: settingsText(settings) }

  const name = SETTING_NAMES[words[0]!.toLowerCase()]
  if (name === undefined) {
    return { text: `There is no setting called "${words[0]}". Use ${NAMES_TEXT}.` }
  }
  const raw = (words[1] ?? '').replace(/^\$/, '')
  const value = Number(raw)
  const [low, cap] = name === 'rate' ? [0, 10000] : name === 'buildRate' ? [1, 1000] : [0, 480]
  if (raw === '' || !Number.isFinite(value) || value < low || value > cap) {
    return {
      text:
        name === 'rate'
          ? 'Give the hourly rate as a number from 0 to 10000, like /report settings rate 75.'
          : name === 'buildRate'
            ? 'Give the lines of code an hour as a number from 1 to 1000, like /report settings buildrate 40.'
            : `Give the minutes as a number from 0 to 480, like /report settings ${words[0]!.toLowerCase()} 15.`,
    }
  }
  const rounded = Math.round(value * 100) / 100

  if (name === 'rate') {
    return { settings: { ...settings, rate: rounded }, text: `Hourly rate is now $${rounded}. The report uses it from now on, for every day.` }
  }
  if (name === 'buildRate') {
    return {
      settings: { ...settings, buildRate: rounded },
      text: `Building software is now estimated at ${rounded} lines of code an hour, for every day.`,
    }
  }
  if (name === 'building') {
    return {
      settings: { ...settings, minutes: { ...settings.minutes, building: rounded } },
      text: `Every Building software task now counts as at least ${rounded} minutes, for every day.`,
    }
  }

  return {
    settings: { ...settings, minutes: { ...settings.minutes, [name]: rounded } },
    text: `${KIND_LABEL[name]} now count as ${rounded} minutes saved per task, for every day.`,
  }
}

// ---------------------------------------------------------------- hours added by hand

const DATE = /^\d{4}-\d{2}-\d{2}$/

// `/report add "QBR builder" 160 2026-05-01`: a project (quoted, or the words
// before the hours), the hours, and an optional date (today when left out).
export const parseAdd = (args: string, today: string): { entry?: Omit<ManualEntry, 'id'>; text?: string } => {
  const usage = 'Try /report add "QBR builder" 160 2026-05-01: the project, the hours, and a date if it was not today.'
  const quoted = /^\s*["“]([^"”]+)["”]\s*(.*)$/.exec(args)
  let project: string
  let rest: string[]
  if (quoted) {
    project = quoted[1]!.trim()
    rest = quoted[2]!.trim().split(/\s+/).filter(Boolean)
  } else {
    const words = args.trim().split(/\s+/).filter(Boolean)
    const at = words.findIndex(word => /^\d+(\.\d+)?h?$/i.test(word))
    if (at <= 0) return { text: usage }
    project = words.slice(0, at).join(' ')
    rest = words.slice(at)
  }
  const hours = Number((rest[0] ?? '').replace(/h$/i, ''))
  if (project === '' || !Number.isFinite(hours) || hours <= 0 || hours > 5000) return { text: usage }
  const date = rest[1] ?? today
  if (!DATE.test(date) || dayKey(noonOf(date)) !== date) return { text: 'Give the date as year-month-day, like 2026-05-01.' }
  if (date > today) return { text: 'That date is in the future. Add hours for work already done.' }

  return { entry: { project: project.slice(0, 60), hours: Math.round(hours * 10) / 10, date } }
}

export const readManual = (kept: unknown): ManualEntry[] =>
  Array.isArray(kept)
    ? kept.filter(
        (one): one is ManualEntry =>
          typeof one === 'object' &&
          one !== null &&
          typeof one.id === 'string' &&
          typeof one.project === 'string' &&
          typeof one.hours === 'number' &&
          typeof one.date === 'string' &&
          DATE.test(one.date),
      )
    : []

export const manualListText = (list: readonly ManualEntry[]): string =>
  list.length === 0
    ? 'No hours added by hand yet. Add one with /report add "QBR builder" 160 2026-05-01.'
    : [
        'Hours you added by hand (estimates):',
        ...list.map((one, i) => `  ${i + 1}. ${one.project}: ${one.hours} h on ${one.date}`),
        'Remove one with /report remove 2.',
      ].join('\n')

// ---------------------------------------------------------------- by project

export type ProjectRow = { name: string; minutes: number; tasks: number }

// Projects by estimated time, the top ones by name and the rest together.
export const projectRows = (totals: Totals, settings: Settings, top = 8): ProjectRow[] => {
  const rows = Object.entries(totals.projects)
    .map(([name, bucket]) => ({ name, minutes: minutesSaved(bucket, settings), tasks: bucket.tasks }))
    .filter(row => row.minutes > 0 || row.tasks > 0)
    .sort((a, b) => b.minutes - a.minutes || b.tasks - a.tasks)
  if (rows.length <= top) return rows
  const rest = rows.slice(top - 1)

  return [
    ...rows.slice(0, top - 1),
    { name: `${rest.length} other projects`, minutes: rest.reduce((n, row) => n + row.minutes, 0), tasks: rest.reduce((n, row) => n + row.tasks, 0) },
  ]
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

// One finished request as scripts/history.py prints it: when, the model, its
// tool calls (name, paths, lines written) and the folder it ran in.
export type PastTask = { t: number; m: string; u: [string, string[], number?][]; c?: string }

export const readHistory = (text: string): PastTask[] => {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) return []

  return raw.filter(
    (task): task is PastTask =>
      typeof task === 'object' && task !== null && typeof task.t === 'number' && typeof task.m === 'string' && Array.isArray(task.u),
  )
}

// The past requests counted into day records, sorted, sized and named by
// project as live ones are.
export const historyDays = (tasks: readonly PastTask[], home = ''): Record<string, DayRecord> => {
  const days: Record<string, DayRecord> = {}
  for (const task of tasks) {
    const key = dayKey(new Date(task.t))
    const uses: ToolUse[] = task.u.map(([tool, paths, lines]) => ({
      tool: String(tool),
      paths: Array.isArray(paths) ? paths.map(String) : [],
      lines: typeof lines === 'number' ? lines : 0,
    }))
    const kind = kindOf(uses)
    const project = typeof task.c === 'string' && task.c !== '' ? projectOfTask(task.c, uses, home) : undefined
    days[key] = addTask(days[key], kind, modelName(task.m), project, kind === 'building' ? taskLines(uses) : 0)
  }

  return days
}
