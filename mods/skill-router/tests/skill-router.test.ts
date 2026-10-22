import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  LOG_LIMIT,
  MODEL_IDS,
  appendLog,
  decide,
  isPinned,
  jevOptions,
  jevRequest,
  logLine,
  parseJev,
  summary,
} from '../hooks/logic'
import type { LogEntry } from '../hooks/logic'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

// The live answer captured 2026-10-21, with the pick swapped per test.
const jevText = (choice: string, probability: number) =>
  JSON.stringify({
    model: 'typesafe/jev-1.14-20261014',
    answers: { model: { type: 'choice', choice, probabilities: { [choice]: probability }, confidence: 0.38 } },
    usage: { input_tokens: 444, output_tokens: 40, cost: 1.8648e-5 },
  })

// ---------------------------------------------------------------- logic

describe('logic', () => {
  test('pins match bare and synced names, nothing else', () => {
    expect(isPinned('docket')).toBe(true)
    expect(isPinned('anthropic-skills:consolidate-memory')).toBe(true)
    expect(isPinned('frameio-to-youtube')).toBe(false)
  })

  test('Jev only sees tiers at or below the session model', () => {
    expect(jevOptions('youtube-script', SONNET)).toEqual(['haiku', 'sonnet'])
    expect(jevOptions('youtube-script', OPUS)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(jevOptions('youtube-script', 'claude-haiku-5-5')).toBe(null)
    expect(jevOptions('youtube-script', 'claude-fable-5-1')).toBe(null)
    expect(jevOptions('docket', OPUS)).toBe(null)
    expect(Object.keys(jevRequest('x', 'd', 'r', ['haiku', 'sonnet']).questions.model.criteria)).toEqual([
      'haiku',
      'sonnet',
    ])
  })

  test('decide', () => {
    expect(decide('docket', OPUS)).toEqual({ source: 'pin', pick: 'haiku', model: MODEL_IDS.haiku })
    expect(decide('docket', 'claude-haiku-5-5').model).toBe(null)
    expect(decide('blog-post', OPUS, null)).toMatchObject({ source: 'kept', model: null })
    expect(decide('blog-post', OPUS, { choice: 'sonnet', probability: 0.4, cost: 0 })).toMatchObject({
      source: 'kept',
      model: null,
    })
    expect(decide('blog-post', OPUS, { choice: 'sonnet', probability: 0.8, cost: 0 })).toMatchObject({
      source: 'jev',
      model: SONNET,
    })
    expect(decide('blog-post', OPUS, { choice: 'opus', probability: 0.8, cost: 0 }).model).toBe(null)
  })

  test('parseJev reads the live shape and refuses an option it was not offered', () => {
    expect(parseJev(jevText('opus', 0.59), ['haiku', 'sonnet', 'opus'])).toEqual({
      choice: 'opus',
      probability: 0.59,
      cost: 1.8648e-5,
    })
    expect(parseJev(jevText('opus', 0.59), ['haiku', 'sonnet'])).toBe(null)
    expect(parseJev('not json', ['haiku'])).toBe(null)
  })

  test('the log keeps the last entries only', () => {
    const entry: LogEntry = { at: 0, skill: 'docket', session: OPUS, source: 'pin', pick: 'haiku', switched: true }
    let list: LogEntry[] = []
    for (let i = 0; i < LOG_LIMIT + 5; i++) list = appendLog(list, { ...entry, at: i })
    expect(list.length).toBe(LOG_LIMIT)
    expect(list[0]?.at).toBe(5)
    expect(logLine(entry)).toContain('opus → haiku')
    expect(summary([entry])).toContain('1 pinned')
  })
})

// ---------------------------------------------------------------- the rig

type Rig = { kept: Map<string, unknown>; models: string[]; fetches: number; session: string; jev: string; key?: string }

const rig = (on: On, overrides: Partial<Rig> = {}): Rig => {
  const r: Rig = {
    kept: new Map(),
    models: [],
    fetches: 0,
    session: OPUS,
    jev: jevText('sonnet', 0.8),
    key: 'sk-or-test',
    ...overrides,
  }
  mock.clock(on, { now: 1_800_000_000_000 })
  on('store.get', ($, e) => ({ value: r.kept.get(e.key) }))
  on('store.set', ($, e) => {
    r.kept.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: r.session }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('env.get', () => ({ value: r.key }))
  on('process.run', () => ({ value: { exitCode: 44, stdout: '', stderr: 'not found' } }) as never)
  on('http.fetch', () => {
    r.fetches++

    return { value: { status: 200, ok: true, headers: {}, text: r.jev } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* ($, e) {
    r.models.push(e.model)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })

  return r
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

const step = async ($: Engine, model: string, agentId?: string) => {
  const stream = $.turn.step({
    turnId: 't1',
    index: 0,
    model,
    messageCount: 3,
    ...(agentId ? { agentId } : {}),
  } as never)
  for await (const _ of stream) {
    // Drain: the bottom yields nothing.
  }
  await stream.result
}

const skill = ($: Engine, name: string) =>
  $.skill.prompt({ skill: name, text: 'body', frontmatter: { description: 'what it does' }, source: 'syncedSkills' })

const finish = ($: Engine) =>
  $.turn.complete({ answer: 'Done.', durationMs: 4200, isAborted: false, turnId: 't1', reason: 'answer' } as never)

const command = ($: Engine, args: string) =>
  $.command.run({
    command: 'skill-router',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

// ---------------------------------------------------------------- hooks

test('a pinned skill runs on Haiku until the next prompt, without asking Jev', async ($, on) => {
  const r = rig(on)
  await start($)
  await $.prompt.submit({ text: 'add milk to the docket', wait: false, origin: { kind: 'composer' } })
  await skill($, 'anthropic-skills:docket')
  await step($, OPUS)
  await finish($)
  await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } })
  await step($, OPUS)

  expect(r.models).toEqual([MODEL_IDS.haiku, OPUS])
  expect(r.fetches).toBe(0)
  const log = r.kept.get('log') as LogEntry[]
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ source: 'pin', pick: 'haiku', switched: true, turnMs: 4200 })
})

test('an unpinned skill follows a sure Jev pick and logs its cost', async ($, on) => {
  const r = rig(on)
  await start($)
  await $.prompt.submit({ text: 'write the blog post', wait: false, origin: { kind: 'composer' } })
  await skill($, 'blog-post')
  await step($, OPUS)
  await finish($)

  expect(r.models).toEqual([SONNET])
  expect((r.kept.get('log') as LogEntry[])[0]).toMatchObject({ source: 'jev', pick: 'sonnet', jevCost: 1.8648e-5 })
})

test('an unsure Jev pick or a missing key keeps the session model', async ($, on) => {
  const r = rig(on, { jev: jevText('haiku', 0.3) })
  await start($)
  await skill($, 'blog-post')
  await step($, OPUS)
  expect(r.models).toEqual([OPUS])

  r.key = undefined
  await skill($, 'youtube-script')
  await step($, OPUS)
  expect(r.models).toEqual([OPUS, OPUS])
})

test('a subagent keeps its own model', async ($, on) => {
  const r = rig(on)
  await start($)
  await skill($, 'docket')
  await step($, SONNET, 'agent-1')
  expect(r.models).toEqual([SONNET])
})

test('off means no routing and no log; the command turns it back on', async ($, on) => {
  const r = rig(on)
  await start($)
  expect((await command($, 'off')).text).toBe('Skill router is off.')
  await skill($, 'docket')
  await step($, OPUS)
  expect(r.models).toEqual([OPUS])
  expect(r.kept.get('log')).toBe(undefined)

  await command($, 'on')
  await skill($, 'docket')
  await step($, OPUS)
  expect(r.models).toEqual([OPUS, MODEL_IDS.haiku])
  expect((await command($, 'status')).text).toContain('OpenRouter key: found')
})
