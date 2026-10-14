// Clean View: hides the tool rows and keeps a plain-English checklist of the
// job above the prompt. Every engine call lives here; the rules are in
// clean-view-logic.ts and the desktop drawing in clean-view-desktop.ts.

import type { EngineInterface, On, Timer } from 'claude-code'

import type { CleanViewChecklist } from '../types'
import { bandSvg, pixelsFor } from './clean-view-desktop'
import {
  GATE_MESSAGE,
  KEEPS_FAILING,
  METER,
  NAME_SYSTEM,
  PERMISSION_REASON,
  QUESTION_REASON,
  SAID_NO,
  addListTask,
  applyList,
  applyListStep,
  applyPlan,
  applyProgress,
  clip,
  composeText,
  continuesJob,
  finishTurn,
  hasPlan,
  headerOf,
  isLive,
  isRealPrompt,
  isRefusedByPerson,
  meterCells,
  nameWidth,
  namePrompt,
  needsYou,
  newJob,
  notificationReason,
  readJobName,
  rowsOf,
  shouldGate,
  stuck,
  titleFromPrompt,
  updateListTask,
} from './clean-view-logic'

type D = EngineInterface

const GOLD = '#F2C46D'
const CORAL = '#F0876A'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#0D1117'

const FAILED = 'Clean View hit a problem and could not do that. Nothing was changed.'
const HELPER_PLAN = 'Helpers skip the plan. Just call report_progress as you work.'

// ---------------------------------------------------------------- state

const ENABLED = { plugin: 'ai-employee-kit', key: 'cleanViewEnabled' } as const
const CHECKLIST = { plugin: 'ai-employee-kit', key: 'checklist' } as const
const TICK = { plugin: 'ai-employee-kit', key: 'tick' } as const

const getEnabled = async ($: D): Promise<boolean> => (await $.state.get(ENABLED)).value ?? true
const getChecklist = async ($: D): Promise<CleanViewChecklist | null> =>
  ((await $.state.get(CHECKLIST)).value as CleanViewChecklist | null | undefined) ?? null
const getTick = async ($: D): Promise<number> => (await $.state.get(TICK)).value ?? 0

// The task list Claude keeps in the desktop app.
const isDesktopList = (tool: string) => tool.startsWith('mcp__ccd_') && tool.endsWith('update_plan')

// Only the terminal gates tools until a plan exists; the desktop app's own
// task list is the plan there.
let isTerminal = false
let failStreak = 0
let lastError: { kind: string | null; details: string } | null = null
let clock: Timer | null = null
let interval = 1000

// Read, apply, write with ifVersion; again on a miss. Starts or stops the
// animation clock to match.
const change = async ($: D, apply: (list: CleanViewChecklist) => CleanViewChecklist | null): Promise<CleanViewChecklist | null> => {
  for (let tries = 0; tries < 20; tries++) {
    const now = await $.state.get(CHECKLIST)
    const current = (now.value as CleanViewChecklist | null | undefined) ?? null
    if (current === null) return null
    const next = apply(current)
    if (next === current) return current
    const result = await $.state.set(CHECKLIST, next, { ifVersion: now.version })
    if (result.isSet) {
      await syncClock($, next)

      return next
    }
  }

  return null
}

const setChecklist = async ($: D, list: CleanViewChecklist | null) => {
  await $.state.set(CHECKLIST, list)
  await syncClock($, list)
}

// One clock, and only while a job is working or waiting on the person.
const syncClock = async ($: D, list: CleanViewChecklist | null) => {
  const shouldRun = isLive(list?.phase) && (await getEnabled($))
  if (shouldRun && clock === null) {
    clock = $.clock.every(interval, () => {
      void (async () => {
        const held = await $.state.get(TICK)
        await $.state.set(TICK, ((held.value ?? 0) + 1) % 1_000_000, { ifVersion: held.version })
      })().catch(() => undefined)
    })
  } else if (!shouldRun && clock !== null) {
    clock.cancel()
    clock = null
  }
}

const setEnabled = async ($: D, isOn: boolean) => {
  await $.state.set(ENABLED, isOn)
  await $.store.set('cleanViewEnabled', isOn)
  await syncClock($, await getChecklist($))
}

// A short name for the job from Haiku, swapped in unless a newer job started.
const nameJob = async ($: D, jobId: number, text: string) => {
  const ask = (withEffort: boolean) =>
    $.model.complete({
      model: 'haiku',
      system: NAME_SYSTEM,
      prompt: namePrompt(text),
      maxTokens: 30,
      timeoutMs: 15_000,
      ...(withEffort ? { effort: 'low' as const } : {}),
    })
  let reply = await ask(true)
  if (!reply.isAnswered && reply.reason === 'api-error' && reply.status === 400) reply = await ask(false)
  if (!reply.isAnswered) return
  const name = readJobName(reply.text)
  if (name === null) return
  await change($, list => (list.jobId === jobId ? { ...list, title: name } : list))
}

const toast = ($: D, isOn: boolean) =>
  $.ui.toast(isOn ? 'Clean View is on. Tool rows are hidden.' : 'Clean View is off. Every row is back.')

export const registerCleanView = (on: On) => {
  // ---------------------------------------------------------------- start

  on('session.start', async ($, e, next) => {
    isTerminal = e.surface === 'terminal'
    interval = isTerminal ? 250 : 1000
    try {
      await $.tool.register({
        name: 'plan_steps',
        description:
          'Lay out every step of the job up front, in plain English a non-technical person understands: 2 to 8 short names in order, each under 40 characters and starting with a verb. The first step starts right away.',
        inputSchema: {
          type: 'object',
          properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
          required: ['steps'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'report_progress',
        description:
          'Report progress on the current step: its plain-English name and a percent from 0 to 100. Report 100 the moment a step finishes; the next one starts by itself.',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
          required: ['task', 'percent'],
        },
        isDeferred: false,
      })
      await $.command.register({
        name: 'simple',
        description: 'Clean View: hide tool rows and show a plain checklist. on, off, or nothing to flip it',
        argumentHint: '[on | off]',
      })
    } catch {
      // registration refused; the rest still works
    }
    try {
      const kept = await $.store.get('cleanViewEnabled')
      await $.state.set(ENABLED, typeof kept === 'boolean' ? kept : true)
      await syncClock($, await getChecklist($))
    } catch {
      // nothing kept yet
    }

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    try {
      const word = e.args.trim().toLowerCase()
      if (word !== '' && word !== 'on' && word !== 'off') return { text: 'Try /simple on, /simple off, or /simple to flip it.' }
      const isOn = word === '' ? !(await getEnabled($)) : word === 'on'
      await setEnabled($, isOn)

      return {
        text: isOn
          ? 'Clean View is on. Tool rows are hidden and the checklist shows above the prompt while Claude works.'
          : 'Clean View is off. Every tool row is back.',
      }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  // ---------------------------------------------------------------- what Claude is told

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await getEnabled($))) return composed
    const hasTaskList = e.tools.some(isDesktopList)

    return {
      ...composed,
      sections: [...composed.sections, { id: 'ai-employee-kit:clean-view', text: composeText(hasTaskList), scope: 'session' as const }],
    }
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- jobs

  on('turn.start', async ($, e, next) => {
    lastError = null
    const list = await getChecklist($)
    if (continuesJob(list)) {
      if (list?.phase === 'needsYou') await change($, one => ({ ...one, phase: 'working', needsYouReason: null }))
    } else if (isRealPrompt(e.text)) {
      failStreak = 0
      const jobId = (list?.jobId ?? 0) + 1
      await setChecklist($, newJob(jobId, titleFromPrompt(e.text), await $.clock.now()))
      if (await getEnabled($)) void nameJob($, jobId, e.text).catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    lastError = { kind: e.error, details: e.error_details ?? '' }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const reason = notificationReason(e.notification_type)
    if (reason !== null) await change($, list => (isLive(list.phase) ? needsYou(list, reason) : list))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await change($, list => (isLive(list.phase) ? needsYou(list, PERMISSION_REASON) : list))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      const finished = await change($, list =>
        isLive(list.phase) ? finishTurn(list, { reason: e.reason, errorKind: lastError?.kind ?? null, errorDetails: lastError?.details ?? '' }, now) : list,
      )
      if (finished?.phase === 'done') {
        const jobId = finished.jobId
        $.clock.after(5000, () => {
          void change($, list => (list.jobId === jobId && list.phase === 'done' ? { ...list, isCollapsed: true } : list)).catch(() => undefined)
        })
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- the two tools

  on('tool.call', { tool: 'mcp__ai-employee-kit__plan_steps' }, async ($, e) => {
    if (e.agentId !== undefined) return { result: HELPER_PLAN }
    const steps = Array.isArray(e.steps) ? (e.steps as unknown[]) : []
    if ((await getChecklist($)) === null) await setChecklist($, newJob(1, 'Working on it', await $.clock.now()))
    let count = 0
    await change($, list => {
      const planned = applyPlan(list, steps)
      count = planned.count

      return planned.list
    })

    return {
      result:
        count === 0
          ? 'Give plan_steps 2 to 8 short step names in plain English.'
          : `Planned ${count} ${count === 1 ? 'step' : 'steps'}. The first one has started.`,
    }
  }).catch(() => ({ result: 'Planned. Go ahead.' }))

  on('tool.call', { tool: 'mcp__ai-employee-kit__report_progress' }, async ($, e) => {
    const raw = typeof e.percent === 'number' ? e.percent : Number(e.percent)
    let percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0
    if (e.agentId === undefined) {
      if ((await getChecklist($)) === null) await setChecklist($, newJob(1, 'Working on it', await $.clock.now()))
      await change($, list => {
        const moved = applyProgress(list, typeof e.task === 'string' ? e.task : '', e.percent)
        percent = moved.percent

        return moved.list
      })
    }

    return { result: `Progress noted: ${percent}%.` }
  }).catch(() => ({ result: 'Progress noted.' }))

  // ---------------------------------------------------------------- every other tool

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isMain = e.agentId === undefined
    const isEnabled = await getEnabled($)
    const list = await getChecklist($)
    if (shouldGate({ isEnabled, isTerminal, agentId: e.agentId, tool, isPlanned: hasPlan(list) })) return { deny: GATE_MESSAGE }
    if (!isMain || list === null) return next(e)

    const input = e as unknown as Record<string, unknown>
    if (tool === 'AskUserQuestion') await change($, one => needsYou(one, QUESTION_REASON))
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos as { content?: unknown; status?: unknown }[]
      await change($, one => applyList(one, todos.map(todo => ({ name: String(todo.content ?? ''), status: String(todo.status ?? '') }))))
    }
    if (isDesktopList(tool)) {
      if (Array.isArray(input.items)) {
        const items = input.items as { content?: unknown; status?: unknown }[]
        await change($, one => applyList(one, items.map(item => ({ name: String(item.content ?? ''), status: String(item.status ?? '') }))))
      } else {
        await change($, one => applyListStep(one, input))
      }
    }
    if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
      const taskId = input.taskId
      await change($, one => updateListTask(one, taskId, input))
    }

    const ran = await next(e)

    if (tool === 'TaskCreate' && ran.deny === undefined && !ran.isError) {
      const created = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id
      if (created !== undefined) await change($, one => addListTask(one, String(created), String(input.subject ?? '')))
    }
    if (ran.deny === undefined && ran.isError === true) {
      if (isRefusedByPerson(ran.text)) {
        failStreak = 0
        await change($, one => stuck(one, SAID_NO))
      } else {
        failStreak += 1
        if (failStreak >= 3) await change($, one => stuck(one, KEEPS_FAILING))
      }
    } else if (ran.deny === undefined) {
      failStreak = 0
      // A step ran: Claude is moving again, past a permission or a failure.
      await change($, one =>
        one.phase === 'stuck' || (one.phase === 'needsYou' && one.needsYouReason !== QUESTION_REASON)
          ? { ...one, phase: 'working', needsYouReason: null, stuckReason: null }
          : one.phase === 'needsYou' && tool === 'AskUserQuestion'
            ? { ...one, phase: 'working', needsYouReason: null }
            : one,
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- hiding the technical rows

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await getEnabled($))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await getEnabled($))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await getEnabled($))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await getEnabled($))) return next(e)

    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // ---------------------------------------------------------------- the on and off button

  // Drawn after whatever else the footer holds (Work Report's button, the
  // engine's mode labels), so the mods sit side by side.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await getEnabled($)

    return (
      <Box flexDirection="row" gap={2}>
        {below}
        <Button
          key="clean-view-toggle"
          plain
          onPress={() => {
            void (async () => {
              const isNowOn = !(await getEnabled($))
              await setEnabled($, isNowOn)
              toast($, isNowOn)
            })().catch(() => undefined)
          }}
        >
          <Text dimColor>{isOn ? 'Clean View: On' : 'Clean View: Off'}</Text>
        </Button>
      </Box>
    )
  })

  // ---------------------------------------------------------------- the checklist band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await getEnabled($))) return next(e)
    const list = await getChecklist($)
    if (list === null || list.phase === 'idle') return next(e)
    const frame = await getTick($)
    const now = await $.clock.now()

    if (e.surface !== 'terminal') {
      const table = $.ui.resolve(e)
      if (!('Svg' in table)) return next(e)
      const { Svg } = table
      const band = bandSvg(list, pixelsFor(e.props.bodyColumns), now)

      return <Svg source={band.source} alt={band.alt} isInteractive={band.isAnimated ? true : undefined} />
    }

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const header = headerOf(list, now, 'you pressed Esc')
    const headerColor = header.kind === 'done' ? GREEN : header.kind === 'stuck' ? AMBER : header.kind === 'stopped' ? MUTED : TEXT
    const headerRow =
      header.badge !== null ? (
        <Box flexDirection="row" width={width}>
          <Text backgroundColor={AMBER} color={INK} bold>{` ${header.badge} `}</Text>
          <Text color={TEXT}>{` ${clip(header.text, width - header.badge.length - 3)}`}</Text>
        </Box>
      ) : (
        <Box flexDirection="row" width={width}>
          <Text color={headerColor} bold>
            {clip(header.text, width)}
          </Text>
        </Box>
      )
    if (list.phase === 'done' && list.isCollapsed) return headerRow

    const nameRoom = nameWidth(width)
    const rows = rowsOf(list)

    return (
      <Box flexDirection="column" width={width}>
        {headerRow}
        {rows.map((row, i) => {
          const one = list.tasks[i]!
          const markColor = row.mark === '✓' ? GREEN : row.mark === '‖' ? AMBER : row.mark === '▶' ? GOLD : MUTED
          const meterColor = one.status === 'done' ? GREEN : one.status === 'active' ? CORAL : LINE

          return (
            <Box key={`row-${one.id}`} flexDirection="row" width={width}>
              <Text color={markColor}>{`${row.mark} `}</Text>
              <Text color={row.tone === 'active' ? TEXT : MUTED} bold={row.tone === 'active'} dimColor={row.tone !== 'active'}>
                {`${clip(row.name, nameRoom).padEnd(nameRoom)} `}
              </Text>
              <Text color={meterColor}>{meterCells(one, frame).slice(0, METER)}</Text>
              <Text color={row.tone === 'active' ? TEXT : MUTED}>{` ${row.label.padStart(7)}`}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
