import type { Elements, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Answer, Flow, HistoryEntry, Outcome, View } from '../types'
import {
  QUESTION_MODEL,
  QUESTION_SYSTEM,
  REWRITE_MODEL,
  REWRITE_SYSTEM,
  answerText,
  bigNumber,
  chipRows,
  classify,
  clip,
  describeFailure,
  parseQuestions,
  parseRewrite,
  questionPrompt,
  rewritePrompt,
  trackerParts,
  wordCount,
  wrap,
} from './logic'
import type { Failure } from './logic'

type D = EngineInterface

const PANE = 'prompt-upgrade'
const TITLE = 'Prompt Upgrade'
const HEADING = 'PROMPT UPGRADE'

const GOLD = '#F2C46D'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#0D1117'

const NARROW = 'Prompt Upgrade needs a wider window, so your words are back in the prompt box.'
const TAKEN = 'Prompt Upgrade has your prompt. Nothing runs until you press Run.'
const FAILED = 'Prompt Upgrade hit a problem and stopped. Nothing was sent.'

// ---------------------------------------------------------------- state

const FLOW = { plugin: 'prompt-upgrade', key: 'flow' } as const
const VIEW = { plugin: 'prompt-upgrade', key: 'view' } as const
const AUTO = { plugin: 'prompt-upgrade', key: 'auto' } as const
const HISTORY = { plugin: 'prompt-upgrade', key: 'history' } as const

// Reads while drawing subscribe the drawing; writes come only from events.
const getFlow = async ($: D): Promise<Flow | null> => (await $.state.get(FLOW)).value ?? null
const getView = async ($: D): Promise<View> => (await $.state.get(VIEW)).value ?? 'flow'
const getAuto = async ($: D): Promise<boolean> => (await $.state.get(AUTO)).value ?? false
const getHistory = async ($: D): Promise<HistoryEntry[]> => (await $.state.get(HISTORY)).value ?? []

// Read, apply, write with ifVersion; again on a miss, so two presses both land.
const changeFlow = async ($: D, change: (flow: Flow | null) => Flow | null): Promise<Flow | null> => {
  for (let tries = 0; tries < 20; tries++) {
    const now = await $.state.get(FLOW)
    const next = change(now.value ?? null)
    const result = await $.state.set(FLOW, next, { ifVersion: now.version })
    if (result.isSet) return next
  }
  throw new Error('flow kept changing')
}

const changeHistory = async ($: D, change: (list: HistoryEntry[]) => HistoryEntry[]): Promise<HistoryEntry[]> => {
  for (let tries = 0; tries < 20; tries++) {
    const now = await $.state.get(HISTORY)
    const next = change(now.value ?? [])
    const result = await $.state.set(HISTORY, next, { ifVersion: now.version })
    if (result.isSet) return next
  }
  throw new Error('history kept changing')
}

const setView = async ($: D, view: View) => {
  await $.state.set(VIEW, view)
}


const blank = (id: string, original: string): Flow => ({
  id,
  original,
  step: 'compose',
  questions: [],
  answers: [],
  otherOpen: null,
  upgraded: '',
  added: [],
  pending: null,
  runId: 0,
  error: null,
  isEditing: false,
  copyNote: null,
})

let counter = 0
const newId = async ($: D): Promise<string> =>
  `${await $.clock.now()}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`

const isWaiting = (
  flow: Flow | null,
  id: string,
  runId: number,
  kind: 'questions' | 'rewrite',
): flow is Flow => flow !== null && flow.id === id && flow.runId === runId && flow.pending === kind

const RANK: Record<Outcome, number> = { ready: 0, cancelled: 1, copied: 2, ran: 3 }

const saveHistory = async ($: D, change: (list: HistoryEntry[]) => HistoryEntry[]) => {
  const list = await changeHistory($, list => change(list).slice(0, 20))
  await $.store.set('history', list)
}

const markOutcome = ($: D, id: string, outcome: Outcome) =>
  saveHistory($, list =>
    list.map(entry =>
      entry.id === id && RANK[outcome] > RANK[entry.outcome] ? { ...entry, outcome } : entry,
    ),
  )

const setAuto = async ($: D, isOn: boolean) => {
  await $.state.set(AUTO, isOn)
  await $.store.set('auto', isOn)
}

// ---------------------------------------------------------------- model calls

type Reply = { ok: true; text: string } | { ok: false; message: string }

const complete = async ($: D, request: Parameters<D['model']['complete']>[0]): Promise<Reply> => {
  try {
    const reply = await $.model.complete(request)
    if (reply.isAnswered) return { ok: true, text: reply.text }

    return { ok: false, message: describeFailure(reply as Failure) }
  } catch {
    return { ok: false, message: 'The model call could not be made.' }
  }
}

const startFlow = async ($: D, original: string): Promise<Flow> => {
  const flow: Flow = { ...blank(await newId($), original), step: 'reading', pending: 'questions', runId: 1 }
  await setView($, 'flow')
  await changeFlow($, () => flow)

  return flow
}

const askQuestions = async ($: D, id: string, runId: number): Promise<void> => {
  const flow = await getFlow($)
  if (!isWaiting(flow, id, runId, 'questions')) return

  const reply = await complete($, {
    model: QUESTION_MODEL,
    system: QUESTION_SYSTEM,
    prompt: questionPrompt(flow.original),
    maxTokens: 800,
    effort: 'low',
    timeoutMs: 30_000,
  })

  const next = await changeFlow($, current => {
    if (!isWaiting(current, id, runId, 'questions')) return current
    if (!reply.ok) {
      return { ...current, step: 'error', pending: null, error: { at: 'questions', message: reply.message } }
    }
    const questions = parseQuestions(reply.text) ?? []
    if (questions.length === 0) {
      return { ...current, step: 'rewrite', pending: 'rewrite', runId: runId + 1 }
    }

    return { ...current, step: 'questions', pending: null, questions, answers: questions.map(() => null) }
  })

  if (isWaiting(next, id, runId + 1, 'rewrite')) await runRewrite($, id, runId + 1)
}

const startRewrite = async ($: D): Promise<void> => {
  const hit = { id: '', runId: 0 }
  await changeFlow($, current => {
    if (current === null || (current.step !== 'questions' && current.step !== 'error')) return current
    hit.id = current.id
    hit.runId = current.runId + 1

    return { ...current, step: 'rewrite', pending: 'rewrite', runId: hit.runId, otherOpen: null, error: null }
  })
  if (hit.id !== '') await runRewrite($, hit.id, hit.runId)
}

const runRewrite = async ($: D, id: string, runId: number): Promise<void> => {
  const flow = await getFlow($)
  if (!isWaiting(flow, id, runId, 'rewrite')) return

  const reply = await complete($, {
    model: REWRITE_MODEL,
    system: REWRITE_SYSTEM,
    prompt: rewritePrompt(flow.original, flow.questions, flow.answers),
    maxTokens: 2000,
    timeoutMs: 90_000,
  })
  const parsed = reply.ok ? parseRewrite(reply.text) : null
  const at = await $.clock.now()

  const next = await changeFlow($, current => {
    if (!isWaiting(current, id, runId, 'rewrite')) return current
    if (!reply.ok) {
      return { ...current, step: 'error', pending: null, error: { at: 'rewrite', message: reply.message } }
    }
    if (parsed === null) {
      return {
        ...current,
        step: 'error',
        pending: null,
        error: { at: 'rewrite', message: 'The rewrite came back in a form I could not read.' },
      }
    }

    return { ...current, step: 'review', pending: null, upgraded: parsed.prompt, added: parsed.added }
  })

  if (parsed !== null && next !== null && next.id === id && next.step === 'review') {
    const entry: HistoryEntry = {
      id,
      at,
      original: next.original,
      upgraded: parsed.prompt,
      added: parsed.added,
      outcome: 'ready',
    }
    await saveHistory($, list => [entry, ...list.filter(one => one.id !== id)])
  }
}

// Picks a step back up after the module reloaded: the pending model call
// died with the old module, so it is made again under a new run id.
const resume = async ($: D): Promise<void> => {
  const flow = await getFlow($)
  if (flow === null) return

  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE)) void $.ui.open({ id: PANE, title: TITLE })

  if (flow.pending === null) return
  const next = await changeFlow($, current =>
    current !== null && current.id === flow.id && current.pending !== null
      ? { ...current, runId: current.runId + 1 }
      : current,
  )
  if (next === null || next.pending === null) return
  if (next.pending === 'questions') await askQuestions($, next.id, next.runId)
  else await runRewrite($, next.id, next.runId)
}

// ---------------------------------------------------------------- actions

const closePane = async ($: D) => {
  await changeFlow($, () => null)
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // already closed
  }
}

// Sends the upgrade as the person's own words. Its origin is this plugin,
// which the prompt.submit hook always lets through, so it cannot loop back.
const runIt = async ($: D, text: string) => {
  const body = text.trim()
  if (body === '') return
  const flow = await getFlow($)
  if (flow !== null) await markOutcome($, flow.id, 'ran')
  await closePane($)
  await $.prompt.submit({ text: body, asUser: true })
}

const cancel = async ($: D) => {
  const flow = await getFlow($)
  await closePane($)
  if (flow === null || flow.original.trim() === '') return
  await markOutcome($, flow.id, 'cancelled')
  await $.prompt.fill({ text: flow.original, mode: 'replace' })
}

const answer = async ($: D, id: string, index: number, value: Answer) => {
  const next = await changeFlow($, current =>
    current !== null && current.id === id && current.step === 'questions'
      ? {
          ...current,
          answers: current.answers.map((one, i) => (i === index ? value : one)),
          otherOpen: current.otherOpen === index ? null : current.otherOpen,
        }
      : current,
  )
  if (next !== null && next.id === id && next.step === 'questions' && next.answers.every(one => one !== null)) {
    await startRewrite($)
  }
}

const retry = async ($: D) => {
  const flow = await getFlow($)
  if (flow === null || flow.error === null) return
  if (flow.error.at === 'rewrite') return startRewrite($)

  const next = await changeFlow($, current =>
    current !== null && current.id === flow.id && current.step === 'error'
      ? { ...current, step: 'reading', pending: 'questions', runId: current.runId + 1, error: null }
      : current,
  )
  if (next !== null && next.pending === 'questions') await askQuestions($, next.id, next.runId)
}

const copy = async ($: D, surface: RenderSurface) => {
  const flow = await getFlow($)
  if (flow === null) return
  const result = await $.ui.copy({ text: flow.upgraded, surface })
  await changeFlow($, current =>
    current !== null && current.id === flow.id
      ? { ...current, copyNote: result.isCopied ? 'copied' : 'failed' }
      : current,
  )
  if (result.isCopied) await markOutcome($, flow.id, 'copied')
}

const patch = ($: D, change: Partial<Flow>) =>
  changeFlow($, current => (current === null ? current : { ...current, ...change }))

const reopen = async ($: D, entry: HistoryEntry) => {
  await changeFlow($, () => ({
    ...blank(entry.id, entry.original),
    step: 'review',
    upgraded: entry.upgraded,
    added: entry.added,
  }))
  await setView($, 'flow')
}

// A handler that never throws into the surface.
const act = (work: () => Promise<unknown>) => () => {
  void work().catch(() => undefined)
}

// Opens the pane. On a terminal too narrow for it, closes it again and puts
// the person's words back in the prompt box. Any other reason it waits
// undrawn (no surface attached yet, one that places nothing) keeps it open,
// since a surface that attaches later draws it; the reason goes in the
// transcript so a pane that never shows says why. Resolves whether the flow
// should go on.
const openPane = async ($: D, restore: string): Promise<boolean> => {
  let opened: Awaited<ReturnType<D['ui']['open']>>
  try {
    opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: 32 })
  } catch (error) {
    $.ui.log(`Prompt Upgrade could not open its pane: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  if (opened.isPlaced) return true
  $.ui.log(`Prompt Upgrade pane is waiting: ${opened.reason}`)
  if (!/column/i.test(opened.reason)) return true
  await closePane($)
  if (restore.trim() !== '') await $.prompt.fill({ text: restore, mode: 'replace' })
  $.ui.toast(NARROW)

  return false
}

// ---------------------------------------------------------------- drawing

type Kit = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
  Input: Elements['terminal']['Input'] | undefined
}

type Chip = { key: string; label: string; tone: 'gold' | 'slate' | 'quiet'; onPress: () => void }

const chipWidth = (chip: Chip) => (chip.tone === 'quiet' ? chip.label.length : chip.label.length + 2)

const drawChip = (kit: Kit, chip: Chip) => {
  const { Button, Text } = kit
  if (chip.tone === 'quiet') {
    return (
      <Button key={chip.key} plain onPress={chip.onPress}>
        <Text color={MUTED}>{chip.label}</Text>
      </Button>
    )
  }

  return (
    <Button key={chip.key} plain onPress={chip.onPress}>
      <Text
        backgroundColor={chip.tone === 'gold' ? GOLD : LINE}
        color={chip.tone === 'gold' ? INK : TEXT}
        bold={chip.tone === 'gold'}
      >
        {` ${chip.label} `}
      </Text>
    </Button>
  )
}

const drawChips = (kit: Kit, chips: Chip[], width: number) => {
  const { Box } = kit
  const fitted = chips.map(chip => ({ ...chip, label: clip(chip.label, Math.max(1, width - 2)) }))

  return (
    <Box flexDirection="column" width={width}>
      {chipRows(fitted, chipWidth, width).map(row => (
        <Box flexDirection="row" gap={1}>
          {row.map(chip => drawChip(kit, chip))}
        </Box>
      ))}
    </Box>
  )
}

const drawHeader = (kit: Kit, width: number, isAuto: boolean) => {
  const { Box, Text } = kit
  const gold = Math.min(HEADING.length, width)
  const badge = isAuto ? 'AUTO ON' : 'AUTO OFF'
  const hasBadge = width >= HEADING.length + badge.length + 2

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={TEXT} wrap="truncate">
          {clip(HEADING, width)}
        </Text>
        {hasBadge && <Text color={isAuto ? GREEN : MUTED}>{badge}</Text>}
      </Box>
      <Box flexDirection="row" width={width}>
        <Text color={GOLD}>{'━'.repeat(gold)}</Text>
        <Text color={LINE}>{'─'.repeat(Math.max(0, width - gold))}</Text>
      </Box>
    </Box>
  )
}

const drawSection = (kit: Kit, width: number, label: string, color = MUTED) => {
  const { Box, Text } = kit
  const shown = clip(label.toUpperCase(), width)

  return (
    <Box flexDirection="row" width={width} marginTop={1}>
      <Text color={color}>{shown}</Text>
      <Text color={LINE}>{shown.length < width ? ` ${'─'.repeat(width - shown.length - 1)}` : ''}</Text>
    </Box>
  )
}

const drawTracker = (kit: Kit, width: number, current: number) => {
  const { Box, Text } = kit
  const parts = trackerParts(current, width)
  const colorOf = (state: 'done' | 'now' | 'todo') => (state === 'done' ? GREEN : state === 'now' ? GOLD : MUTED)

  return (
    <Box flexDirection="row" width={width} marginTop={1}>
      {parts.map((part, i) => (
        <Box flexDirection="row">
          {i > 0 && <Text color={LINE}>{' ── '}</Text>}
          <Text color={colorOf(part.state)} bold={part.state === 'now'}>
            {part.label === '' ? part.mark : `${part.mark} ${part.label}`}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

const drawCard = (
  kit: Kit,
  width: number,
  text: string,
  options: { heading?: string; headingColor?: string; border?: string; maxLines?: number; color?: string } = {},
) => {
  const { Box, Text } = kit
  const inner = Math.max(1, width - 4)
  let lines = wrap(text, inner)
  if (options.maxLines !== undefined && lines.length > options.maxLines) {
    lines = [...lines.slice(0, options.maxLines - 1), clip(`${lines[options.maxLines - 1] ?? ''} …`, inner)]
  }

  return (
    <Box borderStyle="round" borderColor={options.border ?? LINE} paddingX={1} width={width} flexDirection="column">
      {options.heading !== undefined && (
        <Text color={options.headingColor ?? MUTED} bold wrap="truncate">
          {clip(options.heading, inner)}
        </Text>
      )}
      {lines.map(line => (
        <Text color={options.color ?? TEXT} wrap="truncate">
          {line === '' ? ' ' : line}
        </Text>
      ))}
    </Box>
  )
}

const drawNumbers = (kit: Kit, width: number, flow: Flow) => {
  const { Box, Text } = kit
  const before = wordCount(flow.original)
  const after = wordCount(flow.upgraded)
  const added = flow.added.length
  const tiles = [
    { value: before, label: 'WORDS BEFORE', color: TEXT },
    { value: after, label: 'WORDS AFTER', color: GOLD },
    { value: added, label: 'DETAILS ADDED', color: GREEN },
  ].map(tile => {
    const glyph = bigNumber(tile.value)
    const inner = Math.max(glyph[0].length, tile.label.length)

    return { ...tile, glyph, inner, outer: inner + 4 }
  })
  const total = tiles.reduce((n, tile) => n + tile.outer, 0) + (tiles.length - 1)

  if (total > width) {
    return (
      <Box flexDirection="row" width={width} marginTop={1}>
        <Text color={TEXT} wrap="truncate">
          {clip(`${before} words before  ${after} after  ${added} details added`, width)}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={1} marginTop={1} width={width}>
      {tiles.map(tile => (
        <Box borderStyle="round" borderColor={LINE} paddingX={1} flexDirection="column" width={tile.outer}>
          {tile.glyph.map(row => (
            <Text color={tile.color} bold>
              {row}
            </Text>
          ))}
          <Text color={MUTED}>{tile.label}</Text>
        </Box>
      ))}
    </Box>
  )
}

const stepIndex = (flow: Flow): number => {
  if (flow.step === 'compose' || flow.step === 'reading') return 0
  if (flow.step === 'questions') return 1
  if (flow.step === 'rewrite') return 2
  if (flow.step === 'review') return 3

  return flow.error?.at === 'rewrite' ? 2 : 1
}

type Ctx = { kit: Kit; width: number; surface: RenderSurface }

const cancelChip = ($: D): Chip => ({ key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act(() => cancel($)) })

const drawCompose = ($: D, { kit, width }: Ctx) => {
  const { Box, Text, Input } = kit

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, 'Your prompt')}
      {Input !== undefined ? (
        <Input
          key="compose"
          label="Your rough prompt"
          placeholder="Type it, then press Enter"
          autoFocus
          onSubmit={value => {
            if (value.trim() === '') return
            act(async () => {
              const started = await startFlow($, value.trim())
              await askQuestions($, started.id, started.runId)
            })()
          }}
        />
      ) : (
        <Text color={MUTED} wrap="truncate">
          {clip('Type /better followed by your prompt.', width)}
        </Text>
      )}
      <Box marginTop={1}>{drawChips(kit, [cancelChip($)], width)}</Box>
    </Box>
  )
}

const drawReading = ($: D, { kit, width }: Ctx, flow: Flow) => {
  const { Box, Text } = kit

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, 'Your prompt')}
      {drawCard(kit, width, flow.original)}
      {wrap('Reading your prompt and choosing the questions that would help most.', width).map(line => (
        <Text color={MUTED}>{line}</Text>
      ))}
      <Box marginTop={1}>{drawChips(kit, [cancelChip($)], width)}</Box>
    </Box>
  )
}

const drawQuestions = ($: D, { kit, width }: Ctx, flow: Flow) => {
  const { Box, Text, Input } = kit
  const done = flow.answers.filter(one => one !== null).length
  const total = flow.questions.length
  const indent = 4
  const room = Math.max(8, width - indent)

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, 'Your prompt')}
      {drawCard(kit, width, flow.original, { maxLines: 3 })}
      <Box flexDirection="column" marginTop={1} width={width}>
        <Text color={done === total ? GREEN : MUTED} wrap="truncate">
          {clip(`${done} of ${total} answered`, width)}
        </Text>
        {drawChips(
          kit,
          [
            { key: 'skip-rest', label: 'Skip the rest, upgrade now', tone: 'gold', onPress: act(() => startRewrite($)) },
            cancelChip($),
          ],
          width,
        )}
      </Box>
      {drawSection(kit, width, 'Questions')}
      {flow.questions.map((question, i) => {
        const given = flow.answers[i] ?? null
        const lines = wrap(question.question, room)
        const options: Chip[] = question.options.map((option, j) => ({
          key: `q${i}-o${j}`,
          label: option,
          tone: given?.kind === 'option' && given.text === option ? 'gold' : 'slate',
          onPress: act(() => answer($, flow.id, i, { kind: 'option', text: option })),
        }))
        const other: Chip = {
          key: `q${i}-other`,
          label: given?.kind === 'other' ? `Other: ${given.text}` : 'Other (type it)',
          tone: given?.kind === 'other' ? 'gold' : 'slate',
          onPress: act(() => patch($, { otherOpen: i })),
        }
        const skip: Chip = {
          key: `q${i}-skip`,
          label: given?.kind === 'skip' ? 'Skipped' : 'Skip',
          tone: 'quiet',
          onPress: act(() => answer($, flow.id, i, { kind: 'skip' })),
        }

        return (
          <Box flexDirection="column" width={width} marginTop={1}>
            <Box flexDirection="row" width={width}>
              <Text backgroundColor={given === null ? GOLD : GREEN} color={INK} bold>
                {given === null ? ` ${i + 1} ` : ' ✓ '}
              </Text>
              <Text color={TEXT}> {lines[0] ?? ''}</Text>
            </Box>
            {lines.slice(1).map(line => (
              <Text color={TEXT}>{`${' '.repeat(indent)}${line}`}</Text>
            ))}
            <Box paddingLeft={indent} width={width} marginTop={1}>
              {drawChips(kit, [...options, other, skip], room)}
            </Box>
            {flow.otherOpen === i && Input !== undefined && (
              <Box paddingLeft={indent} width={width}>
                <Input
                  key={`other-${i}`}
                  label="Your answer"
                  placeholder="Type it, then press Enter"
                  autoFocus
                  onSubmit={value => {
                    if (value.trim() === '') return
                    act(() => answer($, flow.id, i, { kind: 'other', text: value.trim().slice(0, 200) }))()
                  }}
                />
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

const drawRewrite = ($: D, { kit, width }: Ctx, flow: Flow) => {
  const { Box, Text } = kit
  const pairs = flow.questions.flatMap((question, i) => {
    const text = answerText(flow.answers[i])

    return text === null ? [] : [`${question.question} ${text}`]
  })

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, 'Your prompt')}
      {drawCard(kit, width, flow.original, { maxLines: 3 })}
      {pairs.length > 0 && drawSection(kit, width, 'Your answers')}
      {pairs.flatMap(pair => wrap(pair, width - 2).map((line, j) => <Text color={TEXT}>{`${j === 0 ? '· ' : '  '}${line}`}</Text>))}
      <Box marginTop={1} flexDirection="column" width={width}>
        {wrap('Writing the upgrade from your prompt and answers. Your prompt is safe.', width).map(line => (
          <Text color={MUTED}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>{drawChips(kit, [cancelChip($)], width)}</Box>
    </Box>
  )
}

const drawError = ($: D, { kit, width }: Ctx, flow: Flow) => {
  const { Box, Text } = kit
  const inner = Math.max(1, width - 4)

  return (
    <Box flexDirection="column" width={width}>
      <Box marginTop={1} width={width}>
        <Box borderStyle="round" borderColor={AMBER} paddingX={1} width={width} flexDirection="column">
          <Text color={AMBER} bold wrap="truncate">
            {clip('THAT DID NOT WORK', inner)}
          </Text>
          {wrap(flow.error?.message ?? 'The model call failed.', inner).map(line => (
            <Text color={TEXT}>{line}</Text>
          ))}
          {wrap('Your prompt is safe. Nothing was sent.', inner).map(line => (
            <Text color={GREEN}>{line}</Text>
          ))}
        </Box>
      </Box>
      <Box marginTop={1}>
        {drawChips(
          kit,
          [
            { key: 'retry', label: 'Try again', tone: 'gold', onPress: act(() => retry($)) },
            { key: 'send-original', label: 'Send my original', tone: 'slate', onPress: act(() => runIt($, flow.original)) },
            cancelChip($),
          ],
          width,
        )}
      </Box>
    </Box>
  )
}

const drawReview = ($: D, { kit, width, surface }: Ctx, flow: Flow) => {
  const { Box, Text, Input } = kit
  const isSplit = width >= 64
  const left = isSplit ? Math.floor((width - 1) / 2) : width
  const right = isSplit ? width - 1 - left : width

  const buttons: Chip[] = flow.isEditing
    ? [
        { key: 'back', label: 'Back', tone: 'slate', onPress: act(() => patch($, { isEditing: false })) },
        cancelChip($),
      ]
    : [
        { key: 'run', label: 'Run it', tone: 'gold', onPress: act(() => runIt($, flow.upgraded)) },
        ...(Input !== undefined
          ? [{ key: 'edit', label: 'Edit', tone: 'slate' as const, onPress: act(() => patch($, { isEditing: true })) }]
          : []),
        { key: 'copy', label: 'Copy', tone: 'slate', onPress: act(() => copy($, surface)) },
        cancelChip($),
      ]

  const note =
    flow.copyNote === 'copied'
      ? { text: 'Copied to your clipboard.', color: GREEN }
      : flow.copyNote === 'failed'
        ? { text: 'Could not reach the clipboard here. Select the text instead.', color: AMBER }
        : flow.isEditing
          ? { text: 'Change the text below. Enter runs it.', color: MUTED }
          : null

  const mine = drawCard(kit, left, flow.original, { heading: 'YOURS' })
  const theirs =
    flow.isEditing && Input !== undefined ? (
      <Box flexDirection="column" width={right}>
        <Input
          key="edit-text"
          label="Upgraded prompt"
          value={flow.upgraded}
          submitLabel="Run it"
          autoFocus
          onSubmit={value => act(() => runIt($, value))()}
        />
      </Box>
    ) : (
      drawCard(kit, right, flow.upgraded, { heading: 'UPGRADE', headingColor: GOLD, border: GOLD })
    )

  return (
    <Box flexDirection="column" width={width}>
      {drawNumbers(kit, width, flow)}
      <Box marginTop={1}>{drawChips(kit, buttons, width)}</Box>
      {note !== null && (
        <Text color={note.color} wrap="truncate">
          {clip(note.text, width)}
        </Text>
      )}
      {flow.added.length > 0 && drawSection(kit, width, 'What I added')}
      {flow.added.flatMap(item =>
        wrap(item, width - 2).map((line, j) => (
          <Box flexDirection="row" width={width}>
            <Text color={GREEN}>{j === 0 ? '+ ' : '  '}</Text>
            <Text color={TEXT}>{line}</Text>
          </Box>
        )),
      )}
      {isSplit ? (
        <Box flexDirection="row" gap={1} marginTop={1} width={width}>
          {mine}
          {theirs}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} width={width}>
          {mine}
          {theirs}
        </Box>
      )}
    </Box>
  )
}

const OUTCOME_LABEL: Record<Outcome, { text: string; color: string }> = {
  ready: { text: 'NOT SENT', color: MUTED },
  cancelled: { text: 'CANCELLED', color: MUTED },
  copied: { text: 'COPIED', color: TEXT },
  ran: { text: 'RAN', color: GREEN },
}

const stamp = (at: number) => {
  const date = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

const drawHistory = ($: D, { kit, width }: Ctx, list: HistoryEntry[]) => {
  const { Box, Button, Text } = kit
  const room = Math.max(4, width - 11 - 1 - 1 - 9)

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, list.length === 1 ? 'Last upgrade' : `Last ${list.length} upgrades`)}
      {list.length === 0 && (
        <Text color={MUTED} wrap="truncate">
          {clip('No upgrades yet. Try /better followed by a rough prompt.', width)}
        </Text>
      )}
      {list.map(entry => {
        const label = OUTCOME_LABEL[entry.outcome]
        const first = entry.original.replace(/\s+/g, ' ').trim()

        return (
          <Button key={`hist-${entry.id}`} plain onPress={act(() => reopen($, entry))}>
            <Text color={MUTED}>{`${stamp(entry.at)} `}</Text>
            <Text color={TEXT}>{`${clip(first, room).padEnd(room)} `}</Text>
            <Text color={label.color}>{label.text.padStart(9)}</Text>
          </Button>
        )
      })}
      <Box marginTop={1}>
        {drawChips(
          kit,
          [{ key: 'close', label: 'Close', tone: 'quiet', onPress: act(() => $.ui.close({ id: PANE })) }],
          width,
        )}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt before it runs. Also: on, off, history',
        argumentHint: '[prompt | on | off | history]',
      })
    } catch {
      // registration refused; the rest still works
    }
    try {
      const auto = await $.store.get('auto')
      if (typeof auto === 'boolean') await $.state.set(AUTO, auto)
      const kept = await $.store.get('history')
      if (Array.isArray(kept)) await $.state.set(HISTORY, (kept as HistoryEntry[]).slice(0, 20))
      void resume($).catch(() => undefined)
    } catch {
      // nothing kept yet
    }

    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase()

      if (word === 'on' || word === 'off') {
        await setAuto($, word === 'on')

        return {
          text:
            word === 'on'
              ? 'Automatic mode is on. What you type in the prompt box goes to the pane first. Start a line with > to send it straight through.'
              : 'Automatic mode is off. Prompts go straight to Claude.',
        }
      }

      if (word === 'history') {
        const list = await getHistory($)
        await setView($, 'history')
        void openPane($, '').catch(() => undefined)

        return {
          text:
            list.length === 0
              ? 'No upgrades yet. The pane is open.'
              : list.length === 1
                ? 'Your last upgrade is in the pane.'
                : `Your last ${list.length} upgrades are in the pane.`,
        }
      }

      if (args === '') {
        await setView($, 'flow')
        await changeFlow($, () => blank('compose', ''))
        void openPane($, '').catch(() => undefined)

        return { text: 'Type your rough prompt in the pane.' }
      }

      const flow = await startFlow($, args)
      void openPane($, args)
        .then(goOn => (goOn ? askQuestions($, flow.id, flow.runId) : undefined))
        .catch(() => undefined)

      return { text: 'Upgrading your prompt in the pane. Nothing runs until you press Run.' }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('prompt.submit', async ($, e, next) => {
    const isAuto = await getAuto($)
    if (!isAuto) return next(e)

    // A flow counts as open only while its pane is: one the person closed by
    // hand is dropped here so it never holds automatic mode up.
    const open = await getFlow($)
    const isUp = open !== null && (await $.ui.panes()).some(pane => pane.id === PANE)
    if (open !== null && !isUp) await changeFlow($, () => null)
    const decision = classify(
      {
        text: e.text,
        originKind: e.origin.kind,
        hasAttachments: (e.attachments?.length ?? 0) > 0,
        isMidTurn: e.turnId !== undefined,
      },
      isAuto,
      isUp,
    )
    if (decision.kind === 'pass') return next(e)
    if (decision.kind === 'strip') return next({ ...e, text: decision.text })

    const flow = await startFlow($, e.text)
    const isPlaced = await openPane($, '')
    if (!isPlaced) {
      // The box may still be clearing from the submit; fill it just after.
      $.clock.after(150, () => {
        void $.prompt.fill({ text: e.text, mode: 'replace' }).catch(() => undefined)
      })

      return { drop: NARROW }
    }
    void askQuestions($, flow.id, flow.runId).catch(() => undefined)

    return { drop: TAKEN }
  }).catch(($, e, next) => next(e))

  // The person closing the pane by hand counts as Cancel: their words go back.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      const flow = await getFlow($)
      if (flow !== null) {
        await changeFlow($, () => null)
        if (flow.original.trim() !== '') {
          await markOutcome($, flow.id, 'cancelled')
          await $.prompt.fill({ text: flow.original, mode: 'replace' })
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const kit: Kit = {
      Box: table.Box,
      Text: table.Text,
      Button: table.Button,
      Input: 'Input' in table ? table.Input : undefined,
    }
    const width = Math.max(20, e.props.bodyColumns)
    const ctx: Ctx = { kit, width, surface: e.surface }
    const { Box, Text } = kit

    const view = await getView($)
    const isAuto = await getAuto($)
    const flow = await getFlow($)

    if (view === 'history') {
      const list = await getHistory($)

      return (
        <Box flexDirection="column" width={width}>
          {drawHeader(kit, width, isAuto)}
          {drawHistory($, ctx, list)}
        </Box>
      )
    }

    if (flow === null) {
      return (
        <Box flexDirection="column" width={width}>
          {drawHeader(kit, width, isAuto)}
          <Text color={MUTED} wrap="truncate">
            {clip('Nothing to upgrade. Try /better followed by a rough prompt.', width)}
          </Text>
        </Box>
      )
    }

    const body =
      flow.step === 'compose'
        ? drawCompose($, ctx)
        : flow.step === 'reading'
          ? drawReading($, ctx, flow)
          : flow.step === 'questions'
            ? drawQuestions($, ctx, flow)
            : flow.step === 'rewrite'
              ? drawRewrite($, ctx, flow)
              : flow.step === 'review'
                ? drawReview($, ctx, flow)
                : drawError($, ctx, flow)

    return (
      <Box flexDirection="column" width={width}>
        {drawHeader(kit, width, isAuto)}
        {drawTracker(kit, width, stepIndex(flow))}
        {body}
      </Box>
    )
  })
}
