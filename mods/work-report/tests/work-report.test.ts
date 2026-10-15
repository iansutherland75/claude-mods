import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import type { DayRecord } from '../types'
import {
  DEFAULT_SETTINGS,
  historyDays,
  kindMinutes,
  minutesSaved,
  parseAdd,
  projectOf,
  projectOfTask,
  projectRows,
  readHistory,
  taskLines,
  writtenLines,
  addDays,
  applySetting,
  barsOf,
  bigText,
  dayKey,
  dayOfYear,
  daysOf,
  isTypedPrompt,
  kindOf,
  modelName,
  pathsOf,
  streak,
  sumDays,
  summaryOf,
  tilesPerRow,
  titleOf,
} from '../hooks/logic'

const PLUGIN = 'work-report'
const PANE = 'work-report'
// Local time, so the dates are the same whatever zone the test runs in.
const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime()
const TODAY = '2026-10-14'

const day = (kinds: DayRecord['kinds'], models: DayRecord['models'] = { 'Opus 5.5': 1 }): DayRecord => ({ kinds, models })

// ---------------------------------------------------------------- the rig

type Rig = { kept: Map<string, unknown>; opened: string[]; toasts: string[]; clock: ReturnType<typeof mock.clock> }

// Everything beneath the plugin, answered from memory.
const rig = (on: On, entries: Record<string, unknown> = {}): Rig => {
  const r: Rig = { kept: new Map(Object.entries(entries)), opened: [], toasts: [], clock: mock.clock(on, { now: NOW }) }
  on('store.get', ($, e) => ({ value: r.kept.get(e.key) }))
  on('store.set', ($, e) => {
    r.kept.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    r.kept.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...r.kept.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', () => ({ value: '/Volumes/Ext1/dev/qbr-builder' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    r.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    r.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  // The footer as the engine draws it: its mode labels.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: e.props.modes.join(' & ') })
  })

  return r
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

let turns = 0

// One request from prompt to answer, with the tools it called.
const task = async (
  $: Engine,
  text: string,
  tools: { tool: string; [arg: string]: unknown }[] = [],
  options: { origin?: PromptOrigin; reason?: 'answer' | 'aborted' | 'error'; model?: string; agentId?: string } = {},
) => {
  const turnId = `t${++turns}`
  await $.prompt.submit({ text, wait: false, origin: options.origin ?? { kind: 'composer' } })
  await $.turn.start({ text, turnId })
  for (const [i, call] of tools.entries()) {
    await $.tool.call({ ...call, tool_use_id: `${turnId}-${i}` } as never)
  }
  const reason = options.reason ?? 'answer'
  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1000,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.model !== undefined ? { usage: { ...usage, model: options.model } } : {}),
  } as never)
}

const report = ($: Engine, args = '') =>
  $.command.run({
    command: 'report',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 140 },
  })

const mount = <S extends 'terminal' | 'desktop'>($: Engine, surface: S, width = 80) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PANE,
    props: {
      title: 'Work Report',
      isFocused: true,
      bodyColumns: width,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 120 },
      view: {},
    },
    viewport: { columns: width + 4, rows: 120, isFullscreen: true },
  })

type Found = { type: string; text: string; props: Record<string, unknown> }

const shown = async (ui: { findAll: (query: { type: string }) => Promise<Found[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text)

const has = async (ui: { find: (query: { text: string | RegExp }) => Promise<unknown> }, text: string | RegExp) =>
  (await ui.find({ text })) !== undefined

// Like has, but a miss names what was on screen.
const see = async (ui: { find: (query: { text: string | RegExp }) => Promise<unknown>; findAll: (query: { type: string }) => Promise<Found[]> }, text: string | RegExp) =>
  expect(await has(ui, text), `${String(text)} not in:\n${(await shown(ui)).join('\n')}`).toBe(true)

// ---------------------------------------------------------------- sorting a task

describe('sorting a task by its tools', () => {
  const use = (tool: string, paths: string[] = []) => ({ tool, paths })

  test('mail tools make it an email task', () => {
    expect(kindOf([use('mcp__0c87__outlook_send_mail')])).toBe('emails')
    expect(kindOf([use('mcp__0c87__outlook_create_reply_draft')])).toBe('emails')
    expect(kindOf([use('mcp__gmail__search_threads'), use('WebSearch')])).toBe('emails')
  })

  test('image and video tools, or image and video files', () => {
    expect(kindOf([use('mcp__808a__image_remove_background')])).toBe('media')
    expect(kindOf([use('mcp__YouTube_Uploader__upload_video')])).toBe('media')
    expect(kindOf([use('Write', ['/tmp/thumb.png'])])).toBe('media')
    expect(kindOf([use('Bash', ['ffmpeg -i in.mov out.mp4'])])).toBe('media')
    // Looking at, listing or screenshotting an image is not image work.
    expect(kindOf([use('Read', ['/tmp/screenshot.png'])])).toBe('other')
    expect(kindOf([use('Bash', ['chrome --headless --screenshot=/tmp/peek.png'])])).toBe('other')
    expect(kindOf([use('Bash', ['ls -la /tmp/peek.png'])])).toBe('other')
    expect(kindOf([use('Edit', ['/tmp/clip.mov'])])).toBe('media')
  })

  test('document tools, or writing a document file', () => {
    expect(kindOf([use('mcp__Word__By_Anthropic___insert_text')])).toBe('documents')
    expect(kindOf([use('mcp__PowerPoint__By_Anthropic___add_slide')])).toBe('documents')
    expect(kindOf([use('Write', ['/Users/ian/drafts/blog.md'])])).toBe('documents')
    expect(kindOf([use('Edit', ['/tmp/budget.xlsx'])])).toBe('documents')
    // Reading one is not writing one, and a password is not a Word file.
    expect(kindOf([use('Read', ['/tmp/budget.xlsx'])])).toBe('other')
    expect(kindOf([use('mcp__vault__password_lookup')])).toBe('other')
  })

  test('web search, page reading and transcripts are research', () => {
    expect(kindOf([use('WebSearch')])).toBe('research')
    expect(kindOf([use('WebFetch')])).toBe('research')
    expect(kindOf([use('mcp__Claude_Browser__get_page_text')])).toBe('research')
    expect(kindOf([use('mcp__6895__get_transcript')])).toBe('research')
  })

  test('everything else is Other, and the order decides a mix', () => {
    expect(kindOf([])).toBe('other')
    expect(kindOf([use('Bash', ['git status']), use('Read', ['/tmp/app.ts']), use('ToolSearch')])).toBe('other')
    expect(kindOf([use('Bash', ['git status']), use('Edit', ['/tmp/app.ts']), use('ToolSearch')])).toBe('building')
    expect(kindOf([use('WebSearch'), use('Write', ['/tmp/report.docx'])])).toBe('documents')
    expect(kindOf([use('Write', ['/tmp/report.docx']), use('Write', ['/tmp/cover.jpg'])])).toBe('media')
  })

  test('the paths a tool call names', () => {
    expect(pathsOf({ tool: 'Write', file_path: '/a/b.md', content: 'x' })).toEqual(['/a/b.md'])
    expect(pathsOf({ tool: 'Bash', command: 'ls -la' })).toEqual(['ls -la'])
  })

  test('model names read plainly', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(modelName('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(modelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
    expect(modelName('gpt-x')).toBe('gpt-x')
  })
})

// ---------------------------------------------------------------- what counts

describe('counting only typed prompts', () => {
  test('typed at the terminal, in the desktop app or from the phone', () => {
    expect(isTypedPrompt({ originKind: 'composer', text: 'draft the agenda' })).toBe(true)
    expect(isTypedPrompt({ originKind: 'sdk', text: 'draft the agenda' })).toBe(true)
    expect(isTypedPrompt({ originKind: 'bridge', text: 'draft the agenda' })).toBe(true)
    expect(isTypedPrompt({ originKind: 'plugin', asUser: true, text: 'the upgraded prompt' })).toBe(true)
    expect(isTypedPrompt({ originKind: 'sdk', text: '', hasAttachments: true })).toBe(true)
  })

  test('slash commands, notifications, schedules, peers and empty text do not', () => {
    expect(isTypedPrompt({ originKind: 'composer', text: '/compact' })).toBe(false)
    expect(isTypedPrompt({ originKind: 'composer', text: '   ' })).toBe(false)
    expect(isTypedPrompt({ originKind: 'composer', text: '/compact', hasAttachments: true })).toBe(false)
    expect(isTypedPrompt({ originKind: 'task-notification', text: 'done' })).toBe(false)
    expect(isTypedPrompt({ originKind: 'scheduled-trigger', text: 'run it' })).toBe(false)
    expect(isTypedPrompt({ originKind: 'peer', text: 'hello' })).toBe(false)
    expect(isTypedPrompt({ originKind: 'plugin', text: 'a mod talking' })).toBe(false)
  })

  test('a finished typed request is one task, saved for its day', async ($, on) => {
    const r = rig(on)
    await start($)
    await task($, 'email Stefan the agenda', [{ tool: 'mcp__0c87__outlook_send_mail', to: 'x' }], { model: 'claude-opus-5-5' })
    await task($, 'what changed in the Sherweb API', [{ tool: 'WebSearch', query: 'sherweb api' }])

    expect(r.kept.get(`day:${TODAY}`)).toEqual({
      kinds: { emails: 1, research: 1 },
      models: { 'Opus 5.5': 1, 'Sonnet 5.5': 1 },
      projects: { 'qbr-builder': { kinds: { emails: 1, research: 1 } } },
    })
  })

  test('helper agents, cancelled turns, errors, commands and notifications are not counted', async ($, on) => {
    const r = rig(on)
    await start($)
    await task($, 'stop that', [], { reason: 'aborted' })
    await task($, 'try again', [], { reason: 'error' })
    await task($, '/review', [])
    await task($, 'background job finished', [], { origin: { kind: 'task-notification' } })
    await task($, 'a mod speaking for itself', [], { origin: { kind: 'plugin', name: 'other-mod' } })

    // A helper agent's turn ends inside a typed request: only the request counts.
    const turnId = 'main'
    await $.prompt.submit({ text: 'research and write it up', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'research and write it up', turnId })
    await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'read', tool_use_id: 'w1' } as never)
    await $.turn.complete({ answer: 'notes', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/tmp/notes.md', content: 'x', tool_use_id: 'w2' } as never)
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)

    expect(r.kept.get(`day:${TODAY}`)).toEqual({
      kinds: { documents: 1 },
      models: { 'Sonnet 5.5': 1 },
      projects: { 'qbr-builder': { kinds: { documents: 1 } } },
    })
  })
})

// ---------------------------------------------------------------- days

describe('days', () => {
  test('the streak runs to today, or to yesterday while today is still empty', () => {
    const days = {
      '2026-10-11': day({ other: 1 }),
      '2026-10-12': day({ emails: 2 }),
      '2026-10-13': day({ research: 1 }),
    }
    expect(streak(days, TODAY)).toBe(3)
    expect(streak({ ...days, [TODAY]: day({ other: 1 }) }, TODAY)).toBe(4)
    expect(streak({ '2026-10-12': day({ other: 1 }) }, TODAY)).toBe(0)
    expect(streak({}, TODAY)).toBe(0)
  })

  test('adding days together', () => {
    const days = {
      '2026-10-13': day({ emails: 2, other: 1 }, { 'Opus 5.5': 3 }),
      [TODAY]: day({ emails: 1, documents: 4 }, { 'Opus 5.5': 2, 'Sonnet 5.5': 3 }),
      '2026-09-01': day({ research: 9 }),
    }
    const week = sumDays(days, daysOf('week', TODAY))
    expect(week.tasks).toBe(8)
    expect(week.kinds).toEqual({ emails: 3, documents: 4, building: 0, media: 0, research: 0, other: 1 })
    expect(week.models).toEqual({ 'Opus 5.5': 5, 'Sonnet 5.5': 3 })
    expect(sumDays(days, daysOf('year', TODAY)).tasks).toBe(17)
  })

  test('the day of the year, leap years included', () => {
    expect(dayOfYear('2026-01-01')).toBe(1)
    expect(dayOfYear('2026-12-31')).toBe(365)
    expect(dayOfYear('2028-12-31')).toBe(366)
    expect(dayOfYear(TODAY)).toBe(287)
    expect(daysOf('year', TODAY)).toHaveLength(287)
    expect(daysOf('year', TODAY)[0]).toBe('2026-01-01')
  })

  test('stepping across the clock changes keeps the dates right', () => {
    // Canada and the US: March 8 and November 1, 2026.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-11-02', -2)).toBe('2026-10-31')
    expect(daysOf('week', TODAY)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', TODAY])
    expect(daysOf('month', TODAY)[0]).toBe('2026-09-15')
    expect(dayKey(new Date(NOW))).toBe(TODAY)
  })

  test('each tab names its stretch and dates', () => {
    expect(titleOf('today', TODAY)).toEqual({ name: 'TODAY', dates: 'Wed, Oct 14' })
    expect(titleOf('week', TODAY)).toEqual({ name: 'LAST 7 DAYS', dates: 'Oct 8 to Oct 14' })
    expect(titleOf('month', TODAY)).toEqual({ name: 'LAST 30 DAYS', dates: 'Sep 15 to Oct 14' })
    expect(titleOf('year', TODAY)).toEqual({ name: '2026 SO FAR', dates: 'Jan 1 to Oct 14' })
  })

  test('the chart: seven weekdays, thirty days, twelve months with the future empty', () => {
    const days = { [TODAY]: day({ other: 2 }), '2026-03-02': day({ emails: 5 }) }
    const week = barsOf('week', days, TODAY)
    expect(week.map(bar => bar.label)).toEqual(['Th', 'Fr', 'Sa', 'Su', 'Mo', 'Tu', 'We'])
    expect(week.at(-1)).toEqual({ label: 'We', value: 2, isCurrent: true, isFuture: false })
    expect(barsOf('today', days, TODAY)).toEqual(week)
    expect(barsOf('month', days, TODAY)).toHaveLength(30)
    const year = barsOf('year', days, TODAY)
    expect(year.map(bar => bar.label).join('')).toBe('JFMAMJJASOND')
    expect(year[2]?.value).toBe(5)
    expect(year[9]).toEqual({ label: 'O', value: 2, isCurrent: true, isFuture: false })
    expect(year[10]?.isFuture).toBe(true)
  })

  test('the line under the chart', () => {
    const days = { [TODAY]: day({ other: 2 }), '2026-10-13': day({ other: 1 }), '2026-03-02': day({ emails: 5 }) }
    expect(summaryOf('today', days, TODAY)).toBe('Streak: 2 days in a row.')
    expect(summaryOf('month', days, TODAY)).toBe('Best day Oct 14, 2 tasks. 2 active days.')
    expect(summaryOf('year', days, TODAY)).toBe('Best month March, 5 tasks. 3 active days.')
  })
})

// ---------------------------------------------------------------- settings

describe('settings', () => {
  test('list, change the rate, change minutes, refuse nonsense', () => {
    expect(applySetting('', DEFAULT_SETTINGS).text).toContain('Hourly rate: $50')
    expect(applySetting('', DEFAULT_SETTINGS).text).toContain('Emails 10, Documents 30, Images and video 20, Research 25, Other 10')
    expect(applySetting('rate 75', DEFAULT_SETTINGS).settings?.rate).toBe(75)
    expect(applySetting('emails 15', DEFAULT_SETTINGS).settings?.minutes.emails).toBe(15)
    expect(applySetting('images 40', DEFAULT_SETTINGS).settings?.minutes.media).toBe(40)
    expect(applySetting('rate lots', DEFAULT_SETTINGS).settings).toBeUndefined()
    expect(applySetting('coffee 3', DEFAULT_SETTINGS).text).toContain('no setting called')
  })

  test('/report settings changes what the pane estimates', async ($, on) => {
    const r = rig(on, { [`day:${TODAY}`]: day({ emails: 6 }) })
    await start($)
    expect((await report($, 'settings rate 75')).text).toContain('$75')
    expect((await report($, 'settings emails 15')).text).toContain('15 minutes')
    expect(r.kept.get('settings')).toEqual({ rate: 75, minutes: { ...DEFAULT_SETTINGS.minutes, emails: 15 }, buildRate: 25 })
    expect((await report($, 'settings')).text).toContain('Hourly rate: $75')

    // Six emails at fifteen minutes is 1.5 hours; at $75 that is $113.
    const ui = await mount($, 'terminal', 100)
    expect(await has(ui, 'EST. HOURS SAVED')).toBe(true)
    const text = (await shown(ui)).join('\n')
    expect(text).toContain(bigText('1.5')[0])
    expect(text).toContain(bigText('$113')[0])
  })
})

// ---------------------------------------------------------------- the pane

test('/report answers at once, opens the pane, and every command fails politely', async ($, on) => {
  const r = rig(on)
  await start($)
  const answer = await report($)
  expect(answer.text).toBe('Work Report is open. Hours and dollars are estimates.')
  // The answer comes first; the pane opens just after.
  await r.clock.settle()
  expect(r.opened).toEqual([PANE])
  expect((await report($, 'fortnight')).text).toContain('Try /report')
})

test('each tab draws its own title and chart on the terminal', async ($, on) => {
  rig(on, {
    [`day:${TODAY}`]: day({ emails: 2, documents: 1 }, { 'Opus 5.5': 2, 'Sonnet 5.5': 1 }),
    'day:2026-10-10': day({ research: 1 }),
    'day:2026-09-20': day({ media: 3 }),
    'day:2026-02-11': day({ other: 4 }),
    'day:2025-12-31': day({ other: 9 }),
  })
  await start($)

  for (const surface of ['terminal'] as const) {
    const ui = await mount($, surface, 90)

    await ui.press({ key: 'tab-today' })
    await see(ui, 'TODAY')
    await see(ui, 'Wed, Oct 14')
    await see(ui, 'THE LAST 7 DAYS')
    await see(ui, 'WHERE THE TIME WENT')
    await see(ui, 'WHO DID THE WORK')
    await see(ui, 'Opus 5.5')
    await see(ui, /^Streak: 1 day\.$/)
    // Two emails and a document: 2 x 10 + 30 minutes, 0.8 hours, $42.
    expect((await shown(ui)).join('\n')).toContain(bigText('0.8')[0])

    await ui.press({ key: 'tab-week' })
    await see(ui, 'LAST 7 DAYS')
    await see(ui, 'Oct 8 to Oct 14')
    await see(ui, 'Research')

    await ui.press({ key: 'tab-month' })
    await see(ui, 'LAST 30 DAYS')
    await see(ui, 'THE LAST 30 DAYS')
    await see(ui, /^Best day Oct 14, 3 tasks\. 3 active days\.$/)

    await ui.press({ key: 'tab-year' })
    await see(ui, '2026 SO FAR')
    await see(ui, 'MONTH BY MONTH')
    // Last December is not this year, and a tie goes to the most recent.
    await see(ui, /^Best month October, 4 tasks\. 4 active days\.$/)
    const october = (await ui.findAll({ type: 'Text' })).filter(one => one.text.trim() === 'O')
    expect(october[0]?.props.color).toBe('#F2C46D')

    // The chosen tab is the gold chip.
    const chip = (await ui.findAll({ type: 'Text' })).find(one => one.text === ' Year ')
    expect(chip?.props.backgroundColor).toBe('#F2C46D')
    await ui.unmount()
  }
})

test('the desktop gets real buttons and SVG drawings sized in pixels', async ($, on) => {
  rig(on, {
    [`day:${TODAY}`]: day({ emails: 2, documents: 1 }, { 'Opus 5.5': 2, 'Sonnet 5.5': 1 }),
    'day:2026-02-11': day({ other: 4 }),
  })
  await start($)
  const ui = await mount($, 'desktop', 50)
  const svgs = async () => (await ui.findAll({ type: 'Svg' })).map(one => ({ source: String(one.props.source), alt: String(one.props.alt) }))
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map(one => ({ key: one.key, variant: one.props.variant }))

  expect(await buttons()).toContainEqual({ key: 'tab-today', variant: 'primary' })
  expect(await buttons()).toContainEqual({ key: 'tab-year', variant: 'secondary' })
  let drawn = await svgs()
  expect(drawn.map(one => one.alt)).toEqual([
    'TODAY, Wed, Oct 14',
    'est. hours saved 0.8 h, tasks done 3, est. value $42',
    'Where the time went · est. hours: Emails 2 0.3 h, Documents 1 0.5 h, Building software 0 0 h, Images and video 0 0 h, Research 0 0 h, Other 0 0 h',
    'Who did the work: Opus 5.5 2, Sonnet 5.5 1',
    'The last 7 days: Th 0, Fr 0, Sa 0, Su 0, Mo 0, Tu 0, We 3',
  ])
  // 50 columns draw 650 pixels wide; the gold rule runs under the title only.
  expect(drawn[0]!.source).toContain('width="650"')
  expect(drawn[0]!.source).toMatch(/<line x1="0" y1="33" x2="[\d.]+" y2="33" stroke="#F2C46D"/)
  expect(drawn[4]!.source).toMatch(/fill="#F2C46D"[^>]*>We<\/text>/)

  await ui.press({ key: 'tab-year' })
  expect(await buttons()).toContainEqual({ key: 'tab-year', variant: 'primary' })
  drawn = await svgs()
  expect(drawn[0]!.alt).toBe('2026 SO FAR, Jan 1 to Oct 14')
  const chart = drawn.at(-1)!
  expect(chart.alt).toBe('Month by month: J 0, F 4, M 0, A 0, M 0, J 0, J 0, A 0, S 0, O 3')
  expect(chart.source).toMatch(/fill="#F2C46D"[^>]*>O<\/text>/)
  // November and December are empty: twelve labels, ten bars or baselines.
  expect((chart.source.match(/<rect /g) ?? []).length).toBe(10)
  expect(await has(ui, /^Best month February, 4 tasks\. 2 active days\.$/)).toBe(true)

  // Narrow: one tile per row and a number too wide for the big size set smaller.
  await ui.unmount()
  const narrow = await mount($, 'desktop', 14)
  const tiles = (await narrow.findAll({ type: 'Svg' }))[1]!
  expect(String(tiles.props.source)).toContain('height="312"')
  await narrow.unmount()
})

test('an image sent with no words counts as a task', async ($, on) => {
  const r = rig(on)
  await start($)
  await $.prompt.submit({ text: '', wait: false, origin: { kind: 'sdk' }, attachments: [{ type: 'image' }] } as never)
  await $.turn.start({ text: '', turnId: 'img' })
  await $.turn.complete({ answer: 'That is a pane.', durationMs: 1, isAborted: false, turnId: 'img', reason: 'answer' } as never)
  expect(r.kept.get(`day:${TODAY}`)).toEqual({
    kinds: { other: 1 },
    models: { 'Sonnet 5.5': 1 },
    projects: { 'qbr-builder': { kinds: { other: 1 } } },
  })
})

test('a clean empty state', async ($, on) => {
  rig(on)
  await start($)
  const ui = await mount($, 'terminal')
  expect(await has(ui, 'Nothing finished yet today.')).toBe(true)
  expect(await has(ui, 'EST. HOURS SAVED')).toBe(false)
  expect(await has(ui, 'THE LAST 7 DAYS')).toBe(false)
  await ui.press({ key: 'tab-year' })
  expect(await has(ui, 'Nothing finished this year.')).toBe(true)
})

test('the status bar button shows today and opens the report', async ($, on) => {
  const r = rig(on, { [`day:${TODAY}`]: day({ other: 4 }) })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'SessionMode', requestId: 'mode', props: { modes: ['focus'] } })
    expect(await has(ui, 'Work report · 4 today')).toBe(true)
    expect(await has(ui, 'focus')).toBe(true)
    await ui.press({ key: 'open-work-report' })
    await ui.unmount()
  }
  expect(r.opened).toEqual([PANE, PANE])
})

test('tiles: three, then two, then one as the pane narrows', () => {
  expect(tilesPerRow(80, 20)).toBe(3)
  expect(tilesPerRow(50, 20)).toBe(2)
  expect(tilesPerRow(30, 20)).toBe(1)
})

test('every row fits the pane at a narrow and a wide width', async ($, on) => {
  rig(on, {
    [`day:${TODAY}`]: day({ emails: 120, documents: 340, research: 75 }, { 'Opus 5.5': 400, 'Sonnet 5.5': 135 }),
    'day:2026-10-01': day({ media: 60 }),
    'day:2026-05-05': day({ other: 900 }),
  })
  await start($)

  for (const width of [34, 64, 140]) {
    const ui = await mount($, 'terminal', width)
    for (const tab of ['today', 'week', 'month', 'year'] as const) {
      await ui.press({ key: `tab-${tab}` })
      for (const text of await shown(ui)) {
        expect(text.length <= width, `"${text}" is wider than ${width}`).toBe(true)
      }
      // Rows built from several pieces add up to no more than the width.
      for (const row of await ui.findAll({ type: 'Box' })) {
        if (row.props.flexDirection !== 'row' || row.props.gap !== undefined) continue
        const pieces = row.children.filter(
          (child): child is { type: string; props: Record<string, unknown>; children: unknown[] } =>
            typeof child === 'object' && child !== null && (child as { type?: string }).type === 'Text',
        )
        const total = pieces.reduce((n, piece) => n + piece.children.filter(c => typeof c === 'string').join('').length, 0)
        expect(total <= width, `a row of ${total} is wider than ${width}`).toBe(true)
      }
    }
    // The year is on screen: one tile per row when narrow, three side by side
    // otherwise, and a number too wide for big numerals is plain bold text.
    const tiles = (await ui.findAll({ type: 'Box' })).filter(one => one.props.borderStyle === 'round')
    const tileWidths = tiles.map(one => Number(one.props.width))
    expect(tileWidths).toEqual(width === 34 ? [34, 34, 34] : width === 64 ? [20, 20, 20] : [46, 46, 46])
    expect(await has(ui, /^\$19,563$/)).toBe(width === 64)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- backfill

const PAST = [
  { t: new Date(2026, 6, 14, 9, 0).getTime(), m: 'claude-fable-5', u: [['WebSearch', []]] },
  { t: new Date(2026, 6, 14, 16, 30).getTime(), m: 'claude-fable-5', u: [['Write', ['/tmp/plan.docx']]] },
  { t: new Date(2026, 9, 13, 11, 0).getTime(), m: 'claude-opus-5-5', u: [['mcp__0c87__outlook_send_mail', []], ['Bash', ['git status']]] },
]

test('reading past requests into day records', () => {
  expect(readHistory(JSON.stringify([...PAST, { t: 'bad' }, null]))).toHaveLength(3)
  expect(readHistory('{}')).toEqual([])
  expect(historyDays(readHistory(JSON.stringify(PAST)))).toEqual({
    '2026-07-14': { kinds: { research: 1, documents: 1 }, models: { 'Fable 5': 2 } },
    '2026-10-13': { kinds: { emails: 1 }, models: { 'Opus 5.5': 1 } },
  })
})

test('/report backfill answers at once, reads in the background, and running it twice counts nothing twice', async ($, on) => {
  const r = rig(on, { 'day:2026-10-13': day({ other: 9 }), [`day:${TODAY}`]: day({ other: 2 }) })
  const runs: string[][] = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/Users/ian' : undefined }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: JSON.stringify(PAST), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($)

  for (const round of [1, 2]) {
    const answer = await report($, 'backfill')
    expect(answer.text).toContain('Reading your session history')
    await r.clock.advance(10)
    await r.clock.settle()
    expect(runs).toHaveLength(round)
  }
  expect(runs[0]?.slice(0, 2)).toEqual(['/usr/bin/python3', '-I'])
  expect(runs[0]?.[2]).toMatch(/\/scripts\/history\.py$/)
  expect(runs[0]?.[3]).toBe('/Users/ian/.claude/projects')

  // Days the history covers are replaced; a day it does not cover is kept.
  expect(r.kept.get('day:2026-07-14')).toEqual({ kinds: { research: 1, documents: 1 }, models: { 'Fable 5': 2 } })
  expect(r.kept.get('day:2026-10-13')).toEqual({ kinds: { emails: 1 }, models: { 'Opus 5.5': 1 } })
  expect(r.kept.get(`day:${TODAY}`)).toEqual(day({ other: 2 }))
  expect(r.toasts.at(-1)).toBe('Work Report filled in 3 tasks from your session history, Jul 14 to Oct 13.')
})

test('a failed history read changes nothing and says so', async ($, on) => {
  const r = rig(on, { 'day:2026-10-13': day({ other: 9 }) })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/Users/ian' : undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no python', isStdoutTruncated: false, isStderrTruncated: false } }))
  await start($)
  await report($, 'backfill')
  await r.clock.advance(10)
  await r.clock.settle()
  expect(r.kept.get('day:2026-10-13')).toEqual(day({ other: 9 }))
  expect(r.toasts.at(-1)).toBe('Work Report could not read your session history. Nothing was changed.')
})

// ---------------------------------------------------------------- building software

describe('building software', () => {
  const use = (tool: string, paths: string[] = [], lines = 0) => ({ tool, paths, lines })

  test('writing code or running a build is Building; Remotion stays video', () => {
    expect(kindOf([use('Write', ['/Volumes/Ext1/dev/billing-gap/src/index.ts'], 200)])).toBe('building')
    expect(kindOf([use('Bash', ['npx wrangler deploy'])])).toBe('building')
    expect(kindOf([use('Bash', ['npm test'])])).toBe('building')
    expect(kindOf([use('Write', ['/Volumes/Ext1/remotion/src/Scene.tsx'], 300)])).toBe('media')
    expect(kindOf([use('Write', ['/tmp/notes.md'], 40)])).toBe('documents')
    expect(kindOf([use('Write', ['/tmp/a.ts'], 10), use('mcp__x__outlook_send_mail')])).toBe('emails')
  })

  test('lines written: a rewritten file counts once, edits add up, other files count nothing', () => {
    expect(writtenLines({ content: 'a\nb\nc' })).toBe(3)
    expect(writtenLines({ new_string: 'x\ny' })).toBe(2)
    expect(writtenLines({ edits: [{ new_string: 'a' }, { new_string: 'b\nc' }] })).toBe(3)
    expect(
      taskLines([
        use('Write', ['/r/app.ts'], 100),
        use('Write', ['/r/app.ts'], 120),
        use('Edit', ['/r/util.py'], 5),
        use('Edit', ['/r/util.py'], 7),
        use('Write', ['/r/README.md'], 400),
        use('Write', ['/Volumes/Ext1/remotion/a.tsx'], 900),
        use('Bash', ['npm test']),
      ]),
    ).toBe(132)
  })

  test('the estimate: lines over 25 an hour, never under 30 minutes a task', () => {
    const bucket = { kinds: { emails: 0, documents: 0, building: 3, media: 0, research: 0, other: 2 }, buildLines: [100, 10], manualMinutes: 0 }
    // 100 lines = 240 min; 10 lines = 24 min, floored to 30; one task with no lines kept = 30.
    expect(kindMinutes(bucket, 'building', DEFAULT_SETTINGS)).toBe(300)
    expect(minutesSaved({ ...bucket, manualMinutes: 600 }, DEFAULT_SETTINGS)).toBe(300 + 20 + 600)
    expect(kindMinutes(bucket, 'building', { ...DEFAULT_SETTINGS, buildRate: 50 })).toBe(120 + 30 + 30)
  })

  test('projects by folder, and by the files a task wrote', () => {
    const home = '/Users/ian'
    expect(projectOf('/Volumes/Ext1/dev/qbr-builder/app', home)).toBe('qbr-builder')
    expect(projectOf('/Volumes/4TB_Disk/dev/qbr-builder', home)).toBe('qbr-builder')
    expect(projectOf('/Volumes/Ext1/dev', home)).toBe('dev workspace')
    expect(projectOf('/Volumes/Ext1/3 - remotion/Scene', home)).toBe('3 - remotion')
    expect(projectOf('/Users/ian/claude-mods/mods/x', home)).toBe('claude-mods')
    expect(projectOfTask('/Volumes/Ext1/dev', [use('Write', ['/Volumes/Ext1/dev/onboarding-portal/src/a.ts'], 5)], home)).toBe('onboarding-portal')
    expect(projectOfTask('/Volumes/Ext1/dev', [use('Write', ['/Users/ian/.claude/dev-mods/s1/kit/hooks/a.tsx'], 5)], home)).toBe('claude-mods')
    expect(projectOfTask('/Volumes/Ext1/dev/nnpbc project', [use('Write', ['/private/tmp/x/scratch.sh'], 5)], home)).toBe('nnpbc project')
  })

  test('/report add takes a project, hours and an optional date', () => {
    expect(parseAdd('"QBR builder" 160 2026-05-01', TODAY).entry).toEqual({ project: 'QBR builder', hours: 160, date: '2026-05-01' })
    expect(parseAdd('sentiment engine 80h', TODAY).entry).toEqual({ project: 'sentiment engine', hours: 80, date: TODAY })
    expect(parseAdd('"QBR builder" lots', TODAY).text).toContain('Try /report add')
    expect(parseAdd('"QBR builder" 10 2026-02-30', TODAY).text).toContain('year-month-day')
    expect(parseAdd('"QBR builder" 10 2027-01-01', TODAY).text).toContain('future')
  })

  test('by project: the top ones by name, the rest together, hours added by hand included', () => {
    const days = {
      [TODAY]: {
        kinds: { building: 2, other: 1 },
        models: { 'Opus 5.5': 3 },
        buildLines: [250, 50],
        projects: { 'billing-gap': { kinds: { building: 1 }, buildLines: [250] }, 'nnpbc project': { kinds: { building: 1, other: 1 }, buildLines: [50] } },
      },
    }
    const manual = [{ id: 'm1', project: 'QBR builder', hours: 160, date: '2026-05-01' }]
    const totals = sumDays(days, daysOf('year', TODAY), manual)
    expect(totals.tasks).toBe(3)
    expect(totals.manualMinutes).toBe(9600)
    expect(projectRows(totals, DEFAULT_SETTINGS)).toEqual([
      { name: 'QBR builder', minutes: 9600, tasks: 0 },
      { name: 'billing-gap', minutes: 600, tasks: 1 },
      { name: 'nnpbc project', minutes: 130, tasks: 2 },
    ])
    expect(sumDays(days, daysOf('month', TODAY), manual).manualMinutes).toBe(0)
  })
})

test('a building request is sized by its code and filed under its project', async ($, on) => {
  const r = rig(on)
  await start($)
  await task($, 'add the invoice export', [
    { tool: 'Write', file_path: '/Volumes/Ext1/dev/billing-gap/src/export.ts', content: Array(50).fill('x').join('\n') },
    { tool: 'Bash', command: 'npm test' },
  ])
  expect(r.kept.get(`day:${TODAY}`)).toEqual({
    kinds: { building: 1 },
    models: { 'Sonnet 5.5': 1 },
    buildLines: [50],
    projects: { 'billing-gap': { kinds: { building: 1 }, buildLines: [50] } },
  })
})

test('/report add, list and remove, and the pane shows the hours by project', async ($, on) => {
  const r = rig(on)
  await start($)
  expect((await report($, 'add "QBR builder" 160 2026-05-01')).text).toBe(
    'Added 160 estimated hours for QBR builder on 2026-05-01. /report list shows everything you have added.',
  )
  expect((await report($, 'add sentiment engine 80')).text).toContain('sentiment engine on 2026-10-14')
  expect((await report($, 'list')).text).toContain('1. QBR builder: 160 h on 2026-05-01')
  expect(r.kept.get('manual')).toHaveLength(2)

  // Hours added by hand count toward the year and by project, never as tasks.
  const ui = await mount($, 'desktop', 50)
  await ui.press({ key: 'tab-year' })
  const alts = (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.alt))
  expect(alts).toContain('By project · est. hours: QBR builder 0 160 h, sentiment engine 0 80 h')
  expect(alts.find(alt => alt.startsWith('est. hours saved'))).toBe('est. hours saved 240 h, tasks done 0, est. value $12,000')
  await ui.unmount()

  expect((await report($, 'remove 1')).text).toBe('Removed 160 hours for QBR builder on 2026-05-01.')
  expect((await report($, 'remove 9')).text).toContain('from 1 to 1')
  expect(r.kept.get('manual')).toHaveLength(1)
})
