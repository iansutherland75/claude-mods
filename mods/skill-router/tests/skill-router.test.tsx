import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentCard } from '../types'

import { CONDUCTOR } from '../hooks/conductor'
import {
  LOG_LIMIT,
  MODEL_IDS,
  REVIEWER,
  REVIEW_ASK,
  agentJevOptions,
  appendLog,
  colorOf,
  decide,
  decideAgent,
  expectedTools,
  isPinned,
  jevOptions,
  jevRequest,
  logLine,
  parseJev,
  progressOf,
  routeText,
  statusText,
  toolLine,
  stopDecision,
  summary,
  verdictOf,
} from '../hooks/logic'
import type { LogEntry, Spawn, StopFacts } from '../hooks/logic'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const FABLE = 'claude-fable-5-1'

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

  test('agents: skips, the reviewer pin, an explicit model held down, Jev', () => {
    const spawn = (over: Partial<Spawn> = {}): Spawn => ({ subagentType: 'Explore', fork: false, ...over })
    const sure = { choice: 'haiku' as const, probability: 0.9, cost: 0 }

    expect(decideAgent(spawn({ fork: true }), OPUS, sure)).toMatchObject({ source: 'kept', model: null })
    expect(decideAgent(spawn({ resume: { agentId: 'a' } }), OPUS)).toMatchObject({ source: 'kept', model: null })
    expect(decideAgent(spawn({ workflow: { runId: 'wf_1' } }), OPUS)).toMatchObject({ model: null })
    expect(decideAgent(spawn({ subagentType: 'claude-code-guide' }), OPUS)).toMatchObject({ model: null })
    expect(decideAgent(spawn({ subagentType: REVIEWER }), SONNET)).toEqual({ source: 'pin', pick: 'fable', model: 'fable' })
    expect(decideAgent(spawn({ model: 'opus' }), SONNET)).toMatchObject({ source: 'explicit', pick: 'sonnet', model: SONNET })
    expect(decideAgent(spawn({ model: 'haiku' }), SONNET)).toMatchObject({ source: 'explicit', pick: 'haiku', model: null })
    expect(decideAgent(spawn(), OPUS, sure)).toMatchObject({ source: 'jev', pick: 'haiku', model: MODEL_IDS.haiku })
    expect(decideAgent(spawn(), OPUS, { ...sure, choice: 'opus' })).toMatchObject({ model: MODEL_IDS.opus })
    expect(decideAgent(spawn(), OPUS, { ...sure, probability: 0.3 })).toMatchObject({ source: 'kept', model: null })
    expect(decideAgent(spawn(), OPUS, null)).toMatchObject({ source: 'kept', model: null })
    expect(decideAgent(spawn(), 'claude-haiku-5-5')).toMatchObject({ source: 'kept', model: null })
  })

  test('agents: Jev is offered the session tier and below; under Fable, all three', () => {
    const spawn: Spawn = { subagentType: 'Explore', fork: false }
    expect(agentJevOptions(spawn, SONNET)).toEqual(['haiku', 'sonnet'])
    expect(agentJevOptions(spawn, FABLE)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(agentJevOptions(spawn, 'claude-haiku-5-5')).toBe(null)
    expect(agentJevOptions({ ...spawn, model: 'sonnet' }, OPUS)).toBe(null)
    expect(agentJevOptions({ ...spawn, subagentType: REVIEWER }, OPUS)).toBe(null)
    expect(agentJevOptions({ ...spawn, fork: true }, OPUS)).toBe(null)
  })

  test('the review gate', () => {
    const facts = (over: Partial<StopFacts> = {}): StopFacts => ({
      isReviewOn: true,
      isStopHookActive: false,
      backgroundTasks: 0,
      isTouched: true,
      isReviewed: false,
      ...over,
    })
    expect(stopDecision(facts())).toEqual({ isBlocked: true })
    expect(stopDecision(facts({ isReviewOn: false }))).toEqual({ isBlocked: false })
    expect(stopDecision(facts({ isTouched: false }))).toEqual({ isBlocked: false })
    expect(stopDecision(facts({ isReviewed: true }))).toEqual({ isBlocked: false })
    expect(stopDecision(facts({ isStopHookActive: true }))).toEqual({ isBlocked: false, note: 'review skipped' })
    expect(stopDecision(facts({ backgroundTasks: 2 }))).toMatchObject({ isBlocked: false })
  })

  test('verdicts and 0.1 log entries', () => {
    expect(verdictOf('PASS\n- Did it do what Ian asked? Yes.')).toBe('PASS')
    expect(verdictOf('  FIX\n- foo.ts:3 is wrong')).toBe('FIX')
    expect(verdictOf('**PASS** (no fixes needed)')).toBe('PASS')
    expect(verdictOf('Looks fine')).toBe(undefined)
    expect(verdictOf('PASSING')).toBe(undefined)

    const old: LogEntry = { at: 0, skill: 'docket', session: OPUS, source: 'pin', pick: 'haiku', switched: true }
    const agent: LogEntry = { ...old, kind: 'agent', skill: 'Explore', source: 'jev', pick: 'haiku' }
    const review: LogEntry = { ...old, kind: 'review', skill: REVIEWER, pick: 'fable', verdict: 'FIX', tokensIn: 900 }
    const text = summary([old, agent, review])
    expect(text).toContain('1 skill picks: 1 pinned')
    expect(text).toContain('1 agents: 1 by Jev')
    expect(text).toContain('1 Fable reviews: 0 PASS, 1 FIX, 900 tokens in')
    expect(logLine(review)).toContain('review final-review')
    expect(logLine(review)).toContain('FIX')
  })

  test('agents pane: colour, usual tool count, progress, and the lines on a card', () => {
    expect(colorOf(MODEL_IDS.haiku)).toBe('#3DD68C')
    expect(colorOf(FABLE)).toBe('#F2C46D')
    expect(colorOf(null)).toBe('#7D8590')

    const run = (n: number): LogEntry => ({
      at: 0,
      kind: 'agent',
      skill: 'Explore',
      session: OPUS,
      source: 'jev',
      pick: 'haiku',
      switched: true,
      toolCalls: n,
    })
    expect(expectedTools([], 'Explore')).toBe(15)
    expect(expectedTools([run(10), run(20)], 'Explore')).toBe(15)
    expect(expectedTools([run(10), run(20), run(30)], 'Explore')).toBe(20)
    expect(expectedTools([run(10), run(20), run(30)], 'Plan')).toBe(15)

    const card: AgentCard = {
      id: 'card-1',
      type: 'Explore',
      task: 'Find Keychain reads',
      stage: 'running',
      model: MODEL_IDS.haiku,
      source: 'jev',
      offered: ['haiku', 'sonnet', 'opus'],
      pick: 'haiku',
      probability: 0.99,
      jevMs: 374,
      tools: 6,
      lastTool: 'Grep Keychain',
      expected: 12,
      startedAt: 0,
    }
    expect(progressOf(card)).toBe(0.5)
    expect(progressOf({ ...card, tools: 40 })).toBe(0.9)
    expect(progressOf({ ...card, stage: 'done' })).toBe(1)
    expect(routeText(card)).toBe('Jev picked haiku from haiku / sonnet / opus · p 0.99 · 374 ms')
    expect(routeText({ ...card, source: undefined })).toBe('Agent routing off · runs on haiku')
    expect(statusText(card)).toBe('6 tool calls · Grep Keychain')
    expect(statusText({ ...card, stage: 'done', endedAt: 41_000, tokensIn: 23_400, tokensOut: 1_900 })).toBe(
      'Done · 41 s · 6 tool calls · 23k in / 2k out',
    )
    expect(toolLine({ tool: 'Read', file_path: '/Users/x/hooks/logic.ts' })).toBe('Read logic.ts')
    expect(toolLine({ tool: 'Grep', pattern: 'find-generic-password' })).toBe('Grep find-generic-password')
  })
})

// ---------------------------------------------------------------- the rig

type Rig = {
  kept: Map<string, unknown>
  models: string[]
  spawned: (string | undefined)[]
  opened: string[]
  closed: string[]
  fetches: number
  session: string
  jev: string
  key?: string
}

const rig = (on: On, overrides: Partial<Rig> = {}): Rig => {
  const r: Rig = {
    kept: new Map(),
    models: [],
    spawned: [],
    opened: [],
    closed: [],
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
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    r.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    r.closed.push(e.id)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* ($, e) {
    r.models.push(e.model)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('agent.spawn', ($, e) => {
    r.spawned.push(e.model)

    return { model: e.model ?? e.parentModel, agentId: `agent-${r.spawned.length}` }
  })
  on('tool.call', () => ({ result: {} }) as never)
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return r
}

const spawn = ($: Engine, subagentType: string, extra: object = {}) =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find every place the router reads the Keychain.',
    description: 'Find Keychain reads',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: OPUS,
    background: false,
    fork: false,
    ...extra,
  } as never)

const edit = ($: Engine) =>
  $.tool.call({ tool: 'Edit', file_path: '/tmp/x.md', old_string: 'a', new_string: 'b' } as never)

const stop = ($: Engine, isActive = false) => $.classic.Stop({ stop_hook_active: isActive } as never)

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

// ---------------------------------------------------------------- agents and review

test('a subagent runs on the size Jev picks, and its line gets its tokens', async ($, on) => {
  const r = rig(on, { jev: jevText('haiku', 0.9) })
  await start($)
  const started = await spawn($, 'Explore')
  await $.turn.complete({
    answer: 'Found 2.',
    durationMs: 1500,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    agentId: started.agentId,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)

  expect(r.spawned).toEqual([MODEL_IDS.haiku])
  const line = (r.kept.get('log') as LogEntry[])[0]
  expect(line).toMatchObject({ kind: 'agent', skill: 'Explore', source: 'jev', pick: 'haiku', switched: true })
  expect(line).toMatchObject({ agentId: 'agent-1', tokensIn: 100, tokensOut: 20, turnMs: 1500 })
})

test('the reviewer always runs on Fable; agent routing off leaves other agents alone', async ($, on) => {
  const r = rig(on)
  await start($)
  expect((await command($, 'agents off')).text).toBe('Agent routing is off.')
  await spawn($, 'Explore')
  await spawn($, REVIEWER)
  expect(r.spawned).toEqual([undefined, 'fable'])
  expect(r.fetches).toBe(0)
  expect((r.kept.get('log') as LogEntry[]).map(e => e.kind)).toEqual(['review'])
})

test('real work blocks the stop once until the reviewer runs', async ($, on) => {
  const r = rig(on)
  await start($)
  await $.prompt.submit({ text: 'fix the typo', wait: false, origin: { kind: 'composer' } })
  await edit($)
  expect(await stop($)).toEqual({ block: REVIEW_ASK })

  await spawn($, REVIEWER)
  expect(await stop($, true)).toEqual({})

  // Edits after the review: the model is already going on for a Stop hook,
  // so no second review, and the skip is logged.
  await edit($)
  expect(await stop($, true)).toEqual({})
  expect((r.kept.get('log') as LogEntry[]).at(-1)).toMatchObject({ kind: 'review', note: 'review skipped' })
})

test('no review for a question, with review off, or after a new prompt', async ($, on) => {
  rig(on)
  await start($)
  await $.prompt.submit({ text: 'what does this do?', wait: false, origin: { kind: 'composer' } })
  expect(await stop($)).toEqual({})

  await command($, 'review off')
  await edit($)
  expect(await stop($)).toEqual({})
  await command($, 'review on')

  // A new prompt clears the last one's work.
  await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } })
  expect(await stop($)).toEqual({})
})

test('the conductor rules reach the main session, not a subagent', async ($, on) => {
  rig(on)
  await start($)
  expect(await $.classic.SessionStart({ source: 'startup' } as never)).toEqual({ additionalContext: [CONDUCTOR] })
  expect(await $.classic.SessionStart({ source: 'compact' } as never)).toEqual({ additionalContext: [CONDUCTOR] })
  expect(await $.classic.SessionStart({ source: 'resume' } as never)).toEqual({})
  expect(await $.classic.SessionStart({ source: 'startup', agent_id: 'a1' } as never)).toEqual({})
})

// ---------------------------------------------------------------- agents pane

const PANE_PROPS = { title: 'Agents', isFocused: false, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

const mountPane = ($: Engine, surface: 'terminal' | 'desktop', columns: number) =>
  $.ui.mount({
    plugin: 'skill-router',
    component: 'Pane',
    requestId: 'agents',
    surface,
    props: { ...PANE_PROPS, bodyColumns: columns },
  } as never)

// The pane's text rows, as the terminal draws them, wide enough to read whole.
const paneLines = async ($: Engine): Promise<string[]> => {
  const ui = await mountPane($, 'terminal', 200)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  await ui.unmount()

  return texts
}

// The band above the prompt. A hook of the test's stands for the engine's own
// band beneath the plugin, so a band the plugin leaves alone reads 'engine band'.
const mountBand = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'skill-router',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)

const bandTexts = async ($: Engine, surface: 'terminal' | 'desktop'): Promise<string[]> => {
  const ui = await mountBand($, surface)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  await ui.unmount()

  return texts
}

const prompt = ($: Engine, text: string) => $.prompt.submit({ text, isMeta: false } as never)

test('a spawn gets a card that follows the agent from Jev to done', async ($, on) => {
  const r = rig(on, { jev: jevText('haiku', 0.97) })
  await start($)
  const started = await spawn($, 'Explore')
  // The band is the default view: no pane opens by itself.
  expect(r.opened).toEqual([])

  let lines = await paneLines($)
  expect(lines[0]).toBe('1 running')
  expect(lines[1]).toBe('Explore · haiku · Find Keychain reads')
  expect(lines[2]).toBe('Jev picked haiku from haiku / sonnet / opus · p 0.97 · 0 ms')
  expect(lines[4]).toBe('Started')

  await $.tool.call({ tool: 'Grep', pattern: 'Keychain', agentId: started.agentId } as never)
  await $.tool.call({ tool: 'Read', file_path: '/a/b/register.tsx', agentId: started.agentId } as never)
  // A loop no card holds (a compaction fork) changes nothing.
  await $.tool.call({ tool: 'Read', file_path: '/a/c.ts', agentId: 'fork-x' } as never)
  lines = await paneLines($)
  expect(lines[4]).toBe('2 tool calls · Read register.tsx')

  await $.turn.complete({
    answer: 'Found 2.',
    durationMs: 1500,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    agentId: started.agentId,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)
  lines = await paneLines($)
  expect(lines[0]).toBe('1 finished')
  expect(lines[4]).toBe('Done · 0 s · 2 tool calls · 100 in / 20 out')
  expect((r.kept.get('log') as LogEntry[])[0]).toMatchObject({ toolCalls: 2 })

  // A slash command leaves the finished card; a typed prompt clears it.
  await $.prompt.submit({ text: '/skill-router pane', isMeta: false, command: { name: 'skill-router', args: 'pane' } } as never)
  expect((await paneLines($))[0]).toBe('1 finished')
  expect(r.closed).toEqual([])
  await prompt($, 'next thing')
  expect(await paneLines($)).toEqual(['No agents yet'])
  expect(r.closed).toEqual(['agents'])
})

test('with agent routing off a spawn still gets a card; view off shows it nowhere until asked', async ($, on) => {
  const r = rig(on)
  await start($)
  await command($, 'agents off')
  expect((await command($, 'view off')).text).toContain('nowhere')
  await spawn($, 'Explore')
  const lines = await paneLines($)
  expect(lines[1]).toBe('Explore · opus · Find Keychain reads')
  expect(lines[2]).toBe('Agent routing off · runs on opus')
  expect(r.opened).toEqual([])
  expect(await bandTexts($, 'terminal')).toEqual(['engine band'])
  expect((await command($, 'pane')).text).toBe('Agents pane opened.')
  expect(r.opened).toEqual(['agents'])
})

test('the band shows one row an agent above the chat box, on every surface', async ($, on) => {
  rig(on, { jev: jevText('haiku', 0.95) })
  await start($)
  expect(await bandTexts($, 'terminal')).toEqual(['engine band'])
  const started = await spawn($, 'Explore')
  await $.tool.call({ tool: 'Grep', pattern: 'Keychain', agentId: started.agentId } as never)

  const rows = await bandTexts($, 'terminal')
  expect(rows[0]).toBe('Agents · 1 running')
  expect(rows[1]).toMatch(/^● Explore · haiku  █+░+  1 call · Grep Keychain$/)

  const ui = await mountBand($, 'desktop')
  const svg = (await ui.find({ type: 'Svg' })) as { props?: { alt?: unknown; source?: unknown } } | undefined
  expect(String(svg?.props?.alt)).toBe('Agents: 1 running. Explore on haiku, 1 call · Grep Keychain.')
  expect(String(svg?.props?.source)).toContain('#3DD68C')
  await ui.unmount()
})

test('view pane opens the pane on a spawn and leaves the band to the engine', async ($, on) => {
  const r = rig(on)
  await start($)
  expect((await command($, 'view pane')).text).toContain('beside the chat')
  expect(r.kept.get('view')).toBe('pane')
  await spawn($, 'Explore')
  expect(r.opened).toEqual(['agents'])
  expect(await bandTexts($, 'terminal')).toEqual(['engine band'])
  expect((await command($, 'status')).text).toContain('agents view pane')
})

test('the pane draws a card on every surface', async ($, on) => {
  rig(on, { jev: jevText('sonnet', 0.9) })
  await start($)
  await spawn($, 'Plan')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface, 60)
    expect((await ui.find({ type: 'Text', text: /1 running/ }))?.text).toBe('1 running')
    if (surface === 'desktop') {
      const svg = (await ui.find({ type: 'Svg' })) as { props?: { alt?: unknown; source?: unknown } } | undefined
      expect(String(svg?.props?.alt)).toContain('Plan on sonnet')
      expect(String(svg?.props?.source)).toContain('#58A6FF')
    } else {
      expect((await ui.find({ type: 'Text', text: /Jev picked sonnet/ }))?.text).toContain('p 0.90')
    }
    await ui.unmount()
  }
})
