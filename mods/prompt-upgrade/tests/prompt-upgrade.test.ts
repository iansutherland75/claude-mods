import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, PromptSubmitInput } from 'claude-code'

import { classify, parseQuestions, parseRewrite } from '../hooks/logic'

const PLUGIN = 'prompt-upgrade'
const PANE = 'prompt-upgrade'
const ROUGH = 'write a blog post about backups for small offices'

const QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Who will read it?', options: ['Business owners', 'IT staff'] },
    { question: 'Whose voice?', options: ['Mine', 'The company'] },
    { question: 'How long?', options: ['Short', 'Medium', 'Long'] },
  ],
})
const UPGRADED = 'Write a 600-word blog post for business owners about backups, signed by [author].'
const REWRITE = JSON.stringify({ prompt: UPGRADED, added: ['Audience: business owners', 'Length of 600 words'] })

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answered = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage })

type Rig = {
  clock: ReturnType<typeof mock.clock>
  opened: string[]
  closed: string[]
  fills: string[]
  toasts: string[]
  logs: string[]
  submits: PromptSubmitInput[]
  models: ModelCompleteInput[]
}

// Everything beneath the plugin, answered from memory.
const rig = (
  on: On,
  options: {
    isPlaced?: boolean
    reason?: string
    model?: (e: ModelCompleteInput) => ModelCompleteResult | Promise<ModelCompleteResult>
  } = {},
): Rig => {
  const r: Rig = {
    clock: mock.clock(on, { now: Date.UTC(2026, 9, 14, 16, 0) }),
    opened: [],
    closed: [],
    fills: [],
    toasts: [],
    logs: [],
    submits: [],
    models: [],
  }
  const panes = new Set<string>()
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    r.opened.push(e.id)
    if (options.isPlaced === false) {
      return { value: { isPlaced: false, reason: options.reason ?? 'under the 110-column floor at 80 columns' } }
    }
    panes.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.log', ($, e) => {
    r.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.close', ($, e) => {
    r.closed.push(e.id)
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.toast', ($, e) => {
    r.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('prompt.fill', ($, e) => {
    r.fills.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    r.submits.push(e)

    return { text: e.text }
  })
  on('model.complete', async ($, e) => {
    r.models.push(e)
    const reply = options.model
      ? await options.model(e)
      : answered(e.model === 'haiku' ? QUESTIONS : REWRITE)

    return { value: reply }
  })

  return r
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const better = ($: Engine, args: string) =>
  $.command.run({
    command: 'better',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 140 },
  })

const typed = ($: Engine, text: string, extra: Partial<PromptSubmitInput> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra })

const mount = <S extends 'terminal' | 'desktop'>($: Engine, surface: S, width = 100) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PANE,
    props: {
      title: 'Prompt Upgrade',
      isFocused: true,
      bodyColumns: width,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 80 },
      view: {},
    },
    viewport: { columns: width + 4, rows: 80, isFullscreen: true },
  })

const settle = async (r: Rig) => {
  for (let i = 0; i < 4; i++) await r.clock.settle()
}

const texts = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text)

// ---------------------------------------------------------------- pure rules

describe('which prompts are intercepted', () => {
  const sent = (text: string, more: Partial<Parameters<typeof classify>[0]> = {}) => ({
    text,
    originKind: 'composer',
    hasAttachments: false,
    isMidTurn: false,
    ...more,
  })

  test('a normal typed prompt goes to the pane when automatic mode is on', () => {
    expect(classify(sent(ROUGH), true, false)).toEqual({ kind: 'intercept' })
  })

  test('everything passes when automatic mode is off', () => {
    expect(classify(sent(ROUGH), false, false)).toEqual({ kind: 'pass' })
    expect(classify(sent('> quoted line'), false, false)).toEqual({ kind: 'pass' })
  })

  test('slash commands, attachments, mid-turn and short replies pass', () => {
    expect(classify(sent('/compact now please'), true, false).kind).toBe('pass')
    expect(classify(sent(ROUGH, { hasAttachments: true }), true, false).kind).toBe('pass')
    expect(classify(sent(ROUGH, { isMidTurn: true }), true, false).kind).toBe('pass')
    for (const reply of ['yes', 'Keep going!', 'ok.', 'sounds good', 'do it']) {
      expect(classify(sent(reply), true, false).kind).toBe('pass')
    }
  })

  test('a prompt the mod itself sends always passes, so Run cannot loop', () => {
    expect(classify(sent(UPGRADED, { originKind: 'plugin' }), true, false).kind).toBe('pass')
  })

  test('a line starting with > is sent without the >', () => {
    expect(classify(sent('>  just send this one'), true, false)).toEqual({ kind: 'strip', text: 'just send this one' })
  })

  test('nothing is intercepted while an upgrade is already open', () => {
    expect(classify(sent(ROUGH), true, true).kind).toBe('pass')
  })
})

describe('reading model replies', () => {
  test('questions: fences allowed, at most three, two to four options each', () => {
    const many = JSON.stringify({
      questions: [
        { question: 'A?', options: ['1', '2', '3', '4', '5'] },
        { question: 'Only one option?', options: ['x'] },
        { question: 'B?', options: ['1', '1', '2'] },
        { question: 'C?', options: ['1', '2'] },
        { question: 'D?', options: ['1', '2'] },
      ],
    })
    const parsed = parseQuestions('```json\n' + many + '\n```')
    expect(parsed).toHaveLength(3)
    expect(parsed?.[0]?.options).toHaveLength(4)
    expect(parsed?.[1]).toEqual({ question: 'B?', options: ['1', '2'] })
  })

  test('questions: none, and unreadable', () => {
    expect(parseQuestions('{"questions":[]}')).toEqual([])
    expect(parseQuestions('I would ask about tone.')).toBeNull()
  })

  test('rewrite: JSON, plain text fallback, and empty', () => {
    expect(parseRewrite(REWRITE)).toEqual({ prompt: UPGRADED, added: ['Audience: business owners', 'Length of 600 words'] })
    expect(parseRewrite('Here it is:\n' + REWRITE)?.prompt).toBe(UPGRADED)
    expect(parseRewrite('Just a plain rewrite.')).toEqual({ prompt: 'Just a plain rewrite.', added: [] })
    expect(parseRewrite('   ')).toBeNull()
    expect(parseRewrite('{"prompt":""}')).toBeNull()
  })
})

// ---------------------------------------------------------------- the engine

test('the full flow from /better to Run, on terminal and desktop', async ($, on) => {
  const r = rig(on)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    r.submits.length = 0
    r.models.length = 0

    const answer = await better($, ROUGH)
    expect(answer.text).toContain('Nothing runs until you press Run')
    await settle(r)
    expect(r.opened).toContain(PANE)
    expect(r.models[0]?.model).toBe('haiku')

    const ui = await mount($, surface)
    expect((await ui.find({ text: 'Who will read it?' })) !== undefined).toBe(true)
    expect((await ui.find({ text: '0 of 3 answered' })) !== undefined).toBe(true)

    await ui.press({ key: 'q0-o0' })
    expect((await ui.find({ text: '1 of 3 answered' })) !== undefined).toBe(true)
    await ui.press({ key: 'q1-other' })
    await ui.input({ key: 'other-1', text: 'Ian at Adaptive' })
    await ui.press({ key: 'q2-skip' })
    await settle(r)

    const rewrite = r.models[1]
    expect(rewrite?.model).toBe('sonnet')
    expect(rewrite?.prompt).toContain('Business owners')
    expect(rewrite?.prompt).toContain('Ian at Adaptive')
    expect(rewrite?.prompt).not.toContain('How long?')

    const shown = (await texts(ui)).join('\n')
    expect(shown).toContain('UPGRADE')
    expect(shown).toContain('Audience: business owners')
    expect(shown).toContain('WORDS BEFORE')

    await ui.press({ key: 'run' })
    expect(r.submits).toHaveLength(1)
    expect(r.submits[0]?.text).toBe(UPGRADED)
    expect(r.submits[0]?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
    expect(r.closed).toContain(PANE)
    await ui.unmount()
  }

  const history = await better($, 'history')
  expect(history.text).toBe('Your last 2 upgrades are in the pane.')
})

test('Cancel closes the pane and puts the original back in the prompt box', async ($, on) => {
  const r = rig(on)
  await start($)
  await better($, ROUGH)
  await settle(r)

  const ui = await mount($, 'terminal')
  await ui.press({ key: 'cancel' })
  expect(r.fills).toEqual([ROUGH])
  expect(r.closed).toContain(PANE)
  expect(r.submits).toHaveLength(0)
})

test('the on and off switch, and what passes through while it is on', async ($, on) => {
  const r = rig(on)
  await start($)

  expect((await typed($, ROUGH)).text).toBe(ROUGH)
  expect(r.submits).toHaveLength(1)

  expect((await better($, 'on')).text).toContain('Automatic mode is on')
  const taken = await typed($, ROUGH)
  expect(taken.drop).toContain('Nothing runs until you press Run')
  expect(r.submits).toHaveLength(1)
  await settle(r)
  expect(r.models[0]?.model).toBe('haiku')

  // Passes straight through while the upgrade is open, and short replies always do.
  expect((await typed($, 'yes')).text).toBe('yes')
  expect((await typed($, '> send this exactly')).text).toBe('send this exactly')
  expect((await typed($, ROUGH, { attachments: [{ type: 'image' }] })).text).toBe(ROUGH)

  // Run sends through the same hook and is not caught again.
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'q0-o1' })
  await ui.press({ key: 'skip-rest' })
  await settle(r)
  const before = r.submits.length
  await ui.press({ key: 'run' })
  expect(r.submits).toHaveLength(before + 1)
  expect(r.submits.at(-1)?.text).toBe(UPGRADED)
  expect(r.opened.filter(id => id === PANE)).toHaveLength(1)

  expect((await better($, 'off')).text).toContain('Automatic mode is off')
  expect((await typed($, 'draft the quarterly review agenda')).text).toBe('draft the quarterly review agenda')
})

test('a failed model call shows a calm error and can send the original', async ($, on) => {
  const r = rig(on, {
    model: () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage }),
  })
  await start($)
  await better($, ROUGH)
  await settle(r)

  const ui = await mount($, 'desktop')
  const shown = (await texts(ui)).join('\n')
  expect(shown).toContain('The model is overloaded right now.')
  expect(shown).toContain('Your prompt is safe. Nothing was sent.')

  await ui.press({ key: 'send-original' })
  expect(r.submits.map(one => one.text)).toEqual([ROUGH])
})

test('no questions goes straight to the rewrite', async ($, on) => {
  const r = rig(on, { model: e => answered(e.model === 'haiku' ? '{"questions":[]}' : REWRITE) })
  await start($)
  await better($, ROUGH)
  await settle(r)
  expect(r.models.map(one => one.model)).toEqual(['haiku', 'sonnet'])
  expect(r.models[1]?.prompt).toContain('They answered no questions.')
})

test('a pane that cannot be placed puts the words back and says so', async ($, on) => {
  const r = rig(on, { isPlaced: false })
  await start($)
  await better($, ROUGH)
  await settle(r)
  expect(r.fills).toEqual([ROUGH])
  expect(r.toasts).toHaveLength(1)
  expect(r.toasts[0]).toContain('wider window')
  expect(r.models).toHaveLength(0)
})

test('a pane waiting for a surface stays open, says why, and the flow goes on', async ($, on) => {
  const r = rig(on, { isPlaced: false, reason: 'no-surface: none is attached' })
  await start($)
  await better($, ROUGH)
  await settle(r)
  expect(r.closed).toHaveLength(0)
  expect(r.fills).toHaveLength(0)
  expect(r.toasts).toHaveLength(0)
  expect(r.logs.some(line => line.includes('no-surface'))).toBe(true)
  expect(r.models.length).toBeGreaterThan(0)
})

test('a reload mid-step makes the pending call again', async ($, on) => {
  let release: (value: ModelCompleteResult) => void = () => undefined
  let calls = 0
  const r = rig(on, {
    model: e => {
      calls += 1
      if (calls === 1) return new Promise<ModelCompleteResult>(done => (release = done))

      return answered(e.model === 'haiku' ? QUESTIONS : REWRITE)
    },
  })
  await start($)
  await better($, ROUGH)
  await settle(r)
  expect(calls).toBe(1)

  // A reload runs session.start again with the session's state kept.
  await start($)
  await settle(r)
  expect(calls).toBe(2)

  const ui = await mount($, 'terminal')
  expect((await ui.find({ text: 'Who will read it?' })) !== undefined).toBe(true)

  // The call from before the reload lands late and is ignored.
  release(answered('{"questions":[{"question":"Stale?","options":["a","b"]}]}'))
  await settle(r)
  expect(await ui.find({ text: 'Stale?' })).toBeUndefined()
})

test('every row fits the pane at a narrow and a wide width', async ($, on) => {
  const r = rig(on)
  await start($)
  await better($, ROUGH)
  await settle(r)

  for (const width of [36, 140]) {
    const ui = await mount($, 'terminal', width)
    for (const step of ['questions', 'review'] as const) {
      if (step === 'review') {
        await ui.press({ key: 'skip-rest' })
        await settle(r)
      }
      const rule = (await ui.findAll({ type: 'Text' })).filter(one => /^[━─]+$/.test(one.text))
      expect(rule[0]?.text.length).toBe(Math.min(14, width))
      expect((rule[0]?.text.length ?? 0) + (rule[1]?.text.length ?? 0)).toBe(width)
      for (const text of await texts(ui)) {
        expect(text.length <= width).toBe(true)
      }
    }
    await ui.unmount()
    if (width === 36) {
      await better($, ROUGH)
      await settle(r)
    }
  }
})
