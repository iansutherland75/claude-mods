import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  applyList,
  applyPlan,
  applyProgress,
  cleanName,
  errorSentence,
  finishTurn,
  meterCells,
  newJob,
  readJobName,
  rowsOf,
  shouldGate,
} from '../hooks/clean-view-logic'

const PLUGIN = 'ai-employee-kit'
const PLAN = 'mcp__ai-employee-kit__plan_steps'
const PROGRESS = 'mcp__ai-employee-kit__report_progress'
const DESKTOP_LIST = 'mcp__ccd_turn__update_plan'
const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime()

// ---------------------------------------------------------------- the rig

type Rig = { clock: ReturnType<typeof mock.clock>; toasts: string[]; models: string[]; kept: Map<string, unknown> }

const rig = (on: On, name = 'Build the landing page', answerTools = true): Rig => {
  const r: Rig = { clock: mock.clock(on, { now: NOW }), toasts: [], models: [], kept: new Map() }
  on('store.get', ($, e) => ({ value: r.kept.get(e.key) }))
  on('store.set', ($, e) => {
    r.kept.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('ui.toast', ($, e) => {
    r.toasts.push(e.text)

    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    r.models.push(e.model)

    return { value: { isAnswered: true, text: name, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', () => ({}) as never)
  on('classic.Notification', () => ({}) as never)
  if (answerTools) on('tool.call', () => ({ result: 'ok' }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  // What the engine would draw where the mod draws nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return Box({ key: 'engine-band' })
  })
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'engine modes' })
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'Bash(ls -la)' })
  })

  return r
}

const start = ($: Engine, surface: 'terminal' | null = 'terminal') =>
  $.session.start({ cwd: '/tmp', surface, isInteractive: surface === 'terminal' })

const settle = async (r: Rig) => {
  for (let i = 0; i < 4; i++) await r.clock.settle()
}

// What the desktop band says: its header, then each row as "mark name label".
const said = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'peek',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 60, scroll: { offset: 0, bodyRows: 20 }, view: {} },
    viewport: { columns: 65, rows: 40, isFullscreen: true },
  } as never)
  const svg = (await ui.findAll({ type: 'Svg' }))[0]
  await ui.unmount()

  return svg === undefined ? '' : String(svg.props.alt)
}

const call = ($: Engine, tool: string, args: Record<string, unknown> = {}) => $.tool.call({ tool, ...args } as never)

const band = <S extends 'terminal' | 'desktop'>($: Engine, surface: S, width = 80) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: width, scroll: { offset: 0, bodyRows: 20 }, view: {} },
    viewport: { columns: width + 5, rows: 40, isFullscreen: true },
  } as never)

type Found = { type: string; text: string; props: Record<string, unknown> }
const texts = async (ui: { findAll: (query: { type: string }) => Promise<Found[]> }) => (await ui.findAll({ type: 'Text' })).map(one => one.text)

// ---------------------------------------------------------------- 1. plain names

describe('plain names', () => {
  test('code, paths and code files come out; long names trim to 40', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('Update /src/app/page.tsx with the new copy')).toBe('Update with the new copy')
    expect(cleanName('fix   the   header in Header.tsx')).toBe('Fix the header in')
    const long = cleanName('Rewrite the onboarding emails so they sound friendly and short for new clients')
    expect(long.length <= 40).toBe(true)
    expect(long.endsWith('…')).toBe(true)
    expect(long).toBe('Rewrite the onboarding emails so they…')
    expect(cleanName('`npm run build`')).toBe('Working on it')
    expect(cleanName('')).toBe('Working on it')
  })

  test("Haiku's job name is read plainly, and nonsense is ignored", () => {
    expect(readJobName('"Build the pricing page."')).toBe('Build the pricing page')
    expect(readJobName('Sure')).toBeNull()
  })
})

// ---------------------------------------------------------------- the rules

describe('the checklist rules', () => {
  const job = () => newJob(1, 'Build my landing page', NOW)

  test('5. plan_steps, then report_progress at 100 checks off step one and starts step two', () => {
    const planned = applyPlan(job(), ['Read your brand notes', 'Build the pricing section', 'Add the contact form'])
    expect(planned.count).toBe(3)
    expect(planned.list.tasks.map(one => one.status)).toEqual(['active', 'upcoming', 'upcoming'])
    const moved = applyProgress(planned.list, 'Read your brand notes', 100).list
    expect(moved.tasks.map(one => one.status)).toEqual(['done', 'active', 'upcoming'])
  })

  test('a later step reported checks off the ones before it; an unknown name becomes a new step; percent is clamped', () => {
    const planned = applyPlan(job(), ['One step here', 'Two steps here', 'Three steps here']).list
    const moved = applyProgress(planned, 'Three steps here', 140)
    expect(moved.percent).toBe(100)
    expect(moved.list.tasks.map(one => one.status)).toEqual(['done', 'done', 'done'])
    const extra = applyProgress(planned, 'Check the spelling', -5).list
    expect(extra.tasks.at(-1)).toEqual(expect.objectContaining({ name: 'Check the spelling', status: 'active', percent: 0, hasReported: true }))
  })

  test('the meter: full, filled to the percent, a sweep, empty', () => {
    const list = applyProgress(applyPlan(job(), ['A first step', 'A second step', 'A third step']).list, 'A second step', 60).list
    expect(meterCells(list.tasks[0]!, 0)).toBe('██████████')
    expect(meterCells(list.tasks[1]!, 0)).toBe('██████░░░░')
    expect(meterCells(list.tasks[2]!, 0)).toBe('░░░░░░░░░░')
    const fresh = applyPlan(job(), ['A first step', 'A second step']).list
    expect(meterCells(fresh.tasks[0]!, 3)).toBe('████░░░░░░'.replace('████', '░███'))
    expect(rowsOf(fresh)[0]?.label).toBe('Working')
  })

  test('the end of a turn: done, waiting, stopped, stuck', () => {
    const planned = applyPlan(job(), ['A first step', 'A second step']).list
    expect(finishTurn(planned, { reason: 'answer', errorKind: null, errorDetails: '' }, NOW).phase).toBe('needsYou')
    const quick = finishTurn(job(), { reason: 'answer', errorKind: null, errorDetails: '' }, NOW)
    expect(quick.phase).toBe('done')
    expect(quick.isCollapsed).toBe(true)
    expect(finishTurn(planned, { reason: 'aborted', errorKind: null, errorDetails: '' }, NOW).phase).toBe('stopped')
    const refused = finishTurn(planned, { reason: 'refusal', errorKind: null, errorDetails: '' }, NOW)
    expect(refused.stuckReason).toBe("Claude couldn't help with that request")
  })

  test('API errors read as one calm sentence', () => {
    expect(errorSentence('rate_limit')).toBe('you hit your usage limit, try again a little later')
    expect(errorSentence('overloaded')).toBe("Claude's servers are busy, try again in a minute")
    expect(errorSentence('invalid_request', 'prompt is too long: 210000 tokens')).toBe('type /compact and try again')
    expect(errorSentence('unknown', 'fetch failed: ECONNRESET')).toBe('the internet connection dropped')
    expect(errorSentence('authentication_failed')).toBe('type /login')
  })

  test('the gate: the terminal main agent only, until a plan exists', () => {
    const base = { isEnabled: true, isTerminal: true, tool: 'Bash', isPlanned: false }
    expect(shouldGate(base)).toBe(true)
    expect(shouldGate({ ...base, isPlanned: true })).toBe(false)
    expect(shouldGate({ ...base, isTerminal: false })).toBe(false)
    expect(shouldGate({ ...base, agentId: 'a1' })).toBe(false)
    expect(shouldGate({ ...base, isEnabled: false })).toBe(false)
    for (const tool of ['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN, PROGRESS, DESKTOP_LIST]) {
      expect(shouldGate({ ...base, tool })).toBe(false)
    }
  })

  test('a to-do list becomes the checklist and keeps a reported percent', () => {
    const list = applyProgress(applyList(job(), [
      { name: 'Read your brand notes', status: 'completed' },
      { name: 'Build the pricing section', status: 'in_progress' },
    ]), 'Build the pricing section', 40).list
    const again = applyList(list, [
      { name: 'Read your brand notes', status: 'completed' },
      { name: 'Build the pricing section', status: 'in_progress' },
      { name: 'Add the contact form', status: 'pending' },
    ])
    expect(again.tasks[1]?.percent).toBe(40)
    expect(again.source).toBe('list')
  })
})

// ---------------------------------------------------------------- the engine

const TODOS = [
  { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
  { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
  { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
  { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
]

test('2. a to-do list and a 60% report draw ✓ / ▶ 60% / Next / Up next on the terminal and the desktop', async ($, on) => {
  const r = rig(on)
  await start($)
  await $.turn.start({ text: 'Build my landing page with pricing', turnId: 't1' })
  await settle(r)
  await call($, 'TodoWrite', { todos: TODOS })
  await call($, PROGRESS, { task: 'Build the pricing section', percent: 60 })

  const terminal = await band($, 'terminal')
  const shown = (await texts(terminal)).join('|')
  expect(shown).toContain('Build the landing page · 0s')
  expect(shown).toContain('✓ ')
  expect(shown).toContain('██████████')
  expect(shown).toContain('▶ ')
  expect(shown).toContain('██████░░░░')
  expect(shown).toContain('    60%')
  expect(shown).toContain('   Next')
  expect(shown).toContain('Up next')
  for (const text of await texts(terminal)) expect(text.length <= 80).toBe(true)
  await terminal.unmount()

  const desktop = await band($, 'desktop', 50)
  const svg = (await desktop.findAll({ type: 'Svg' }))[0]
  expect(String(svg?.props.alt)).toBe(
    'Build the landing page · 0s. ✓ Read your brand notes Done. ▶ Build the pricing section 60%. ○ Add the contact form Next. ○ Polish the footer Up next',
  )
  expect(String(svg?.props.source)).toContain('width="650"')
  expect(r.models).toEqual(['haiku'])
})

test('the desktop task list fills the band, and nothing is gated in a desktop session', async ($, on) => {
  const r = rig(on)
  await start($, null)
  await $.turn.start({ text: 'Write the quarterly review', turnId: 't1' })
  await settle(r)
  expect((await call($, 'Bash', { command: 'ls' })).deny).toBeUndefined()
  await call($, DESKTOP_LIST, { items: [{ content: 'Gather the numbers', status: 'in_progress' }, { content: 'Draft the summary', status: 'pending' }] })
  await call($, DESKTOP_LIST, { advance: true })
  expect(await said($)).toBe('Build the landing page · 0s. ✓ Gather the numbers Done. ▶ Draft the summary Working')

  // A plain image (an interactive one is framed small), with the sweep drawn
  // where the clock has it; the switch rides with the band.
  const desktop = await band($, 'desktop')
  const svg = (await desktop.findAll({ type: 'Svg' }))[0]
  expect(String(svg?.props.source)).toContain('fill="url(#cv-sweep)"')
  expect(String(svg?.props.source)).not.toContain('<animate')
  expect(svg?.props.isInteractive).toBeUndefined()
  await desktop.press({ key: 'clean-view-band-toggle' })
  expect(r.toasts.at(-1)).toBe('Clean View is off. Every row is back. Type /simple on to bring it back.')
  expect(await said($)).toBe('')
})

test('3. a permission prompt shows Needs you, and the next tool clears it', async ($, on) => {
  const r = rig(on)
  await start($, null)
  await $.turn.start({ text: 'Clean up the downloads folder', turnId: 't1' })
  await settle(r)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } } as never)
  expect(await said($)).toMatch(/^Claude needs your OK to continue\. ‖ Understand your request/)
  const ui = await band($, 'terminal')
  expect((await texts(ui)).join('|')).toContain(' Needs you ')
  expect((await texts(ui)).join('|')).toContain('Claude needs your OK to continue')
  await ui.unmount()
  await call($, 'Bash', { command: 'ls' })
  expect(await said($)).toMatch(/^Build the landing page · 0s\. ▶ Understand your request/)

  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  expect(await said($)).toMatch(/^Claude needs your OK to continue\./)
})

test('4. /simple off hides the band and brings tool rows back; the choice is saved', async ($, on) => {
  const r = rig(on)
  await start($, null)
  await $.turn.start({ text: 'Plan the team offsite', turnId: 't1' })
  await settle(r)

  const row = { plugin: PLUGIN, surface: 'desktop' as const, component: 'ToolUse' as const, requestId: 'tu1', props: { tool_use_id: 'tu1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false } }
  const hidden = await $.ui.mount(row as never)
  expect((await hidden.findAll({ type: 'Box' }))[0]?.props.display).toBe('none')
  await hidden.unmount()

  expect((await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text).toContain('Clean View is off')
  expect(r.kept.get('cleanViewEnabled')).toBe(false)
  const ui = await band($, 'terminal')
  expect(await ui.find({ key: 'engine-band' })).toBeDefined()
  expect(await ui.find({ text: /Plan the team/ })).toBeUndefined()
  await ui.unmount()
  const shown = await $.ui.mount(row as never)
  expect(await shown.find({ text: 'Bash(ls -la)' })).toBeDefined()

  // The footer button turns it back on, with a toast.
  const footer = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'SessionMode', requestId: 'mode', props: { modes: [] } } as never)
  expect(await footer.find({ text: 'engine modes' })).toBeDefined()
  expect(await footer.find({ text: 'Clean View: Off' })).toBeDefined()
  await footer.press({ key: 'clean-view-toggle' })
  expect(r.toasts.at(-1)).toBe('Clean View is on. Tool rows are hidden.')
  expect(r.kept.get('cleanViewEnabled')).toBe(true)
})

test('6. in the terminal any tool is denied before a plan exists and allowed after', async ($, on) => {
  const r = rig(on)
  await start($, 'terminal')
  await $.turn.start({ text: 'Fix the broken contact form', turnId: 't1' })
  await settle(r)
  const before = await call($, 'Bash', { command: 'ls' })
  expect(before.deny).toContain('plan_steps')
  expect((await call($, 'ToolSearch', { query: 'select:plan_steps', max_results: 1 })).deny).toBeUndefined()
  expect((await call($, PLAN, { steps: ['Find the problem', 'Fix the form'] })).result).toBe('Planned 2 steps. The first one has started.')
  expect((await call($, 'Bash', { command: 'ls' })).deny).toBeUndefined()
  // Helpers are never gated.
  await $.turn.start({ text: 'Another job', turnId: 't2' })
})

test('plan_steps then report_progress at 100 moves the checklist; a finished turn shows All done and shrinks after 5 seconds', async ($, on) => {
  const r = rig(on)
  await start($, null)
  await $.turn.start({ text: 'Write a welcome email', turnId: 't1' })
  await settle(r)
  await call($, PLAN, { steps: ['Draft the email', 'Check the tone'] })
  expect((await call($, PROGRESS, { task: 'Draft the email', percent: 100 })).result).toBe('Progress noted: 100%.')
  expect(await said($)).toBe('Build the landing page · 0s. ✓ Draft the email Done. ▶ Check the tone Working')
  await call($, PROGRESS, { task: 'Check the tone', percent: 100 })
  await r.clock.advance(134_000)
  await $.turn.complete({ answer: 'Here it is.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const ui = await band($, 'terminal')
  expect((await texts(ui))[0]).toBe('✓ All done · Build the landing page · took 2m 14s')
  expect((await texts(ui)).length > 1).toBe(true)
  await ui.unmount()
  await r.clock.advance(5000)
  await settle(r)
  expect(await said($)).toBe('✓ All done · Build the landing page · took 2m 14s')
  const small = await band($, 'terminal')
  expect(await texts(small)).toEqual(['✓ All done · Build the landing page · took 2m 14s'])
})

test('three failures in a row show Stuck; a success clears it; a refused permission pauses', async ($, on) => {
  const r = rig(on, 'Build the landing page', false)
  let fail = true
  let refuse = false
  on('tool.call', { tool: 'Bash' }, () =>
    (refuse
      ? { result: 'no', isError: true, text: "The user doesn't want to proceed with this tool use." }
      : fail
        ? { result: 'boom', isError: true, text: 'Exit code 1' }
        : { result: 'ok' }) as never,
  )
  await start($, null)
  await $.turn.start({ text: 'Run the monthly report', turnId: 't1' })
  await settle(r)
  for (let i = 0; i < 3; i++) await call($, 'Bash', { command: 'make' })
  expect(await said($)).toMatch(/^⚠ Stuck: a step keeps failing, Claude is trying another way\./)
  fail = false
  await call($, 'Bash', { command: 'make' })
  expect(await said($)).toMatch(/^Build the landing page · /)
  refuse = true
  await call($, 'Bash', { command: 'rm' })
  expect(await said($)).toMatch(/^⚠ Stuck: you said no to a step, so Claude paused\./)
})

test('the instructions reach Claude only while Clean View is on, and name the right plan', async ($, on) => {
  rig(on)
  await start($, null)
  const desktop = await $.prompt.compose({ model: 'opus', promptModel: 'opus', surfaces: ['desktop'], tools: [DESKTOP_LIST], outputStyle: null, traits: [] } as never)
  expect(desktop.sections.at(-1)?.text).toContain('Your task list is the plan')
  const terminal = await $.prompt.compose({ model: 'opus', promptModel: 'opus', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] } as never)
  expect(terminal.sections.at(-1)?.text).toContain(`call ${PLAN} first`)
  await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const off = await $.prompt.compose({ model: 'opus', promptModel: 'opus', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] } as never)
  expect(off.sections).toHaveLength(1)
})
