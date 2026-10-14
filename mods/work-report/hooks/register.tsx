import type { Elements, EngineInterface, Register } from 'claude-code'

import type { DayRecord, Kind, Settings, Tab } from '../types'
import {
  DEFAULT_SETTINGS,
  KINDS,
  KIND_LABEL,
  addDays,
  addTask,
  applySetting,
  barCells,
  barsOf,
  bigText,
  clip,
  dayKey,
  daysOf,
  emptyText,
  hoursText,
  isTypedPrompt,
  kindOf,
  minutesSaved,
  modelName,
  moneyText,
  pathsOf,
  readDay,
  readSettings,
  shortDate,
  streak,
  sumDays,
  summaryOf,
  tasksOn,
  tilesPerRow,
  titleOf,
  wrap,
} from './logic'
import type { Bar, ToolUse, Totals } from './logic'

type D = EngineInterface

const PANE = 'work-report'
const TITLE = 'Work Report'
const TABS: readonly Tab[] = ['today', 'week', 'month', 'year']
const TAB_LABEL: Record<Tab, string> = { today: 'Today', week: 'Week', month: 'Month', year: 'Year' }

const GOLD = '#F2C46D'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const INK = '#0D1117'

const KIND_COLOR: Record<Kind, string> = {
  emails: '#79C0FF',
  documents: GOLD,
  media: '#D2A8FF',
  research: '#56D4DD',
  other: MUTED,
}
const MODEL_COLORS = [GOLD, '#79C0FF', '#D2A8FF', '#56D4DD', GREEN, MUTED]

const FAILED = 'Work Report hit a problem and could not do that. Nothing was changed.'
const NARROW = 'Work Report needs a wider window. Widen it and run /report again.'

// ---------------------------------------------------------------- state

const DAYS = { plugin: 'work-report', key: 'days' } as const
const SETTINGS = { plugin: 'work-report', key: 'settings' } as const
const TAB = { plugin: 'work-report', key: 'tab' } as const

// Reads while drawing subscribe the drawing; writes come only from events.
const getDays = async ($: D): Promise<Record<string, DayRecord>> => (await $.state.get(DAYS)).value ?? {}
const getSettings = async ($: D): Promise<Settings> => readSettings((await $.state.get(SETTINGS)).value)
const getTab = async ($: D): Promise<Tab> => (await $.state.get(TAB)).value ?? 'today'

const todayOf = async ($: D) => dayKey(new Date(await $.clock.now()))

// Read, apply, write with ifVersion; again on a miss.
const changeDays = async ($: D, change: (days: Record<string, DayRecord>) => Record<string, DayRecord>) => {
  for (let tries = 0; tries < 20; tries++) {
    const now = await $.state.get(DAYS)
    const result = await $.state.set(DAYS, change(now.value ?? {}), { ifVersion: now.version })
    if (result.isSet) return
  }
}

// Loads the kept days the tabs can show (this calendar year and the last 31
// days) so every session on this machine sees the same counts.
const loadDays = async ($: D) => {
  const today = await todayOf($)
  const oldest = [`${today.slice(0, 4)}-01-01`, addDays(today, -31)].sort()[0]!
  const loaded: Record<string, DayRecord> = {}
  for (const name of await $.store.keys()) {
    if (!name.startsWith('day:')) continue
    const key = name.slice(4)
    if (key < oldest) continue
    const day = readDay(await $.store.get(name))
    if (day !== undefined) loaded[key] = day
  }
  await changeDays($, () => loaded)
}

const loadSettings = async ($: D) => {
  await $.state.set(SETTINGS, readSettings(await $.store.get('settings')))
}

const record = async ($: D, kind: Kind, model: string) => {
  const today = await todayOf($)
  const day = addTask(readDay(await $.store.get(`day:${today}`)), kind, model)
  await $.store.set(`day:${today}`, day)
  await changeDays($, days => ({ ...days, [today]: day }))
}

const openReport = async ($: D) => {
  await loadDays($)
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced) $.ui.toast(NARROW)
}

const act = (work: () => Promise<unknown>) => () => {
  void work().catch(() => undefined)
}

// ---------------------------------------------------------------- drawing

type Kit = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
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
      <Text backgroundColor={chip.tone === 'gold' ? GOLD : LINE} color={chip.tone === 'gold' ? INK : TEXT} bold={chip.tone === 'gold'}>
        {` ${chip.label} `}
      </Text>
    </Button>
  )
}

// Chips laid out in rows that each fit the width.
const drawChips = (kit: Kit, chips: Chip[], width: number) => {
  const { Box } = kit
  const rows: Chip[][] = []
  let row: Chip[] = []
  let used = 0
  for (const chip of chips.map(one => ({ ...one, label: clip(one.label, Math.max(1, width - 2)) }))) {
    const w = chipWidth(chip)
    if (row.length > 0 && used + 1 + w > width) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length > 0 ? 1 : 0) + w
    row.push(chip)
  }
  if (row.length > 0) rows.push(row)

  return (
    <Box flexDirection="column" width={width}>
      {rows.map(line => (
        <Box flexDirection="row" gap={1}>
          {line.map(chip => drawChip(kit, chip))}
        </Box>
      ))}
    </Box>
  )
}

const drawTabs = ($: D, kit: Kit, width: number, tab: Tab) =>
  drawChips(
    kit,
    TABS.map(one => ({
      key: `tab-${one}`,
      label: TAB_LABEL[one],
      tone: one === tab ? 'gold' : 'slate',
      onPress: act(async () => {
        await loadDays($)
        await $.state.set(TAB, one)
      }),
    })),
    width,
  )

const drawTitle = (kit: Kit, width: number, name: string, dates: string) => {
  const { Box, Text } = kit
  const title = clip(name, width)
  const hasDates = title.length + 2 + dates.length <= width
  const gold = Math.min(title.length, width)

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={TEXT}>
          {title}
        </Text>
        {hasDates && <Text color={MUTED}>{dates}</Text>}
      </Box>
      <Box flexDirection="row" width={width}>
        <Text color={GOLD}>{'━'.repeat(gold)}</Text>
        <Text color={LINE}>{'─'.repeat(Math.max(0, width - gold))}</Text>
      </Box>
    </Box>
  )
}

const drawSection = (kit: Kit, width: number, label: string) => {
  const { Box, Text } = kit
  const shown = clip(label.toUpperCase(), width)

  return (
    <Box flexDirection="row" width={width} marginTop={1}>
      <Text color={MUTED}>{shown}</Text>
      <Text color={LINE}>{shown.length + 1 < width ? ` ${'─'.repeat(width - shown.length - 1)}` : ''}</Text>
    </Box>
  )
}

const TILE_MIN = 20

const drawTiles = (kit: Kit, width: number, totals: Totals, settings: Settings) => {
  const { Box, Text } = kit
  const minutes = minutesSaved(totals.kinds, settings)
  const tiles = [
    { key: 'hours', value: hoursText(minutes), plain: `${hoursText(minutes)} h`, label: 'EST. HOURS SAVED', color: GOLD },
    { key: 'tasks', value: String(totals.tasks), plain: totals.tasks.toLocaleString('en-US'), label: 'TASKS DONE', color: TEXT },
    {
      key: 'value',
      value: moneyText(minutes, settings.rate),
      plain: moneyText(minutes, settings.rate, true),
      label: 'EST. VALUE',
      color: GREEN,
    },
  ]
  const perRow = tilesPerRow(width, TILE_MIN, tiles.length)
  const tileWidth = Math.floor((width - (perRow - 1)) / perRow)
  const inner = Math.max(1, tileWidth - 4)
  const rows: (typeof tiles)[] = []
  for (let i = 0; i < tiles.length; i += perRow) rows.push(tiles.slice(i, i + perRow))

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      {rows.map(row => (
        <Box flexDirection="row" gap={1} width={width}>
          {row.map(tile => {
            const glyph = bigText(tile.value)
            const isBig = glyph[0].length <= inner

            return (
              <Box key={`tile-${tile.key}`} borderStyle="round" borderColor={LINE} paddingX={1} flexDirection="column" width={tileWidth}>
                {isBig
                  ? glyph.map(line => (
                      <Text color={tile.color} bold>
                        {line}
                      </Text>
                    ))
                  : [' ', clip(tile.plain, inner), ' '].map(line => (
                      <Text color={tile.color} bold>
                        {line}
                      </Text>
                    ))}
                <Text color={MUTED}>{clip(tile.label, inner)}</Text>
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

// A labelled bar row: the label, a colored bar on a dim track, then the figures.
const drawBarRow = (kit: Kit, width: number, row: { key: string; label: string; value: number; max: number; color: string; figures: string }) => {
  const { Box, Text } = kit
  const labelWidth = Math.min(16, Math.max(6, Math.floor(width * 0.35)))
  const figures = row.figures
  const track = width - labelWidth - 1 - 1 - figures.length
  const isZero = row.value === 0

  if (track < 3) {
    const label = clip(row.label, Math.max(1, width - figures.length - 1))

    return (
      <Box key={row.key} flexDirection="row" width={width}>
        <Text color={isZero ? MUTED : TEXT}>{label.padEnd(width - figures.length)}</Text>
        <Text color={isZero ? MUTED : TEXT}>{figures}</Text>
      </Box>
    )
  }
  const filled = row.max <= 0 || isZero ? 0 : Math.max(1, Math.round((row.value / row.max) * track))

  return (
    <Box key={row.key} flexDirection="row" width={width}>
      <Text color={isZero ? MUTED : TEXT}>{`${clip(row.label, labelWidth).padEnd(labelWidth)} `}</Text>
      <Text color={row.color}>{'━'.repeat(filled)}</Text>
      <Text color={LINE}>{`${'─'.repeat(track - filled)} `}</Text>
      <Text color={isZero ? MUTED : TEXT}>{figures}</Text>
    </Box>
  )
}

const drawKinds = (kit: Kit, width: number, totals: Totals, settings: Settings) => {
  const { Box } = kit
  const max = Math.max(...KINDS.map(kind => totals.kinds[kind]))
  const hourTexts = KINDS.map(kind => `${hoursText(totals.kinds[kind] * settings.minutes[kind])}h`)
  const hourWidth = Math.max(...hourTexts.map(text => text.length))
  const countWidth = Math.max(...KINDS.map(kind => String(totals.kinds[kind]).length))

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, 'Where the time went · est. hours')}
      {KINDS.map((kind, i) =>
        drawBarRow(kit, width, {
          key: `kind-${kind}`,
          label: KIND_LABEL[kind],
          value: totals.kinds[kind],
          max,
          color: KIND_COLOR[kind],
          figures: `${String(totals.kinds[kind]).padStart(countWidth)}  ${hourTexts[i]!.padStart(hourWidth)}`,
        }),
      )}
    </Box>
  )
}

const drawModels = (kit: Kit, width: number, totals: Totals) => {
  const { Box } = kit
  const list = Object.entries(totals.models)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  const max = list[0]?.[1] ?? 0
  const countWidth = Math.max(1, ...list.map(([, n]) => String(n).length))

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, 'Who did the work')}
      {list.map(([model, n], i) =>
        drawBarRow(kit, width, {
          key: `model-${i}`,
          label: model,
          value: n,
          max,
          color: MODEL_COLORS[i % MODEL_COLORS.length]!,
          figures: String(n).padStart(countWidth),
        }),
      )}
    </Box>
  )
}

const CHART_HEADING: Record<Tab, string> = {
  today: 'The last 7 days',
  week: 'The last 7 days',
  month: 'The last 30 days',
  year: 'Month by month',
}

const barColor = (bar: Bar) => (bar.isCurrent ? GOLD : bar.isFuture ? LINE : MUTED)

const drawChart = (kit: Kit, width: number, tab: Tab, all: Bar[], today: string) => {
  const { Box, Text } = kit
  // Too narrow for thirty: the most recent days that fit.
  const bars = all.length > width ? all.slice(all.length - width) : all
  const slot = Math.max(1, Math.floor(width / bars.length))
  const barWidth = slot >= 3 ? slot - 1 : 1
  const gap = slot - barWidth
  const max = Math.max(0, ...bars.map(bar => bar.value))

  const rows = [0, 1, 2].map(row => (
    <Box flexDirection="row" width={width}>
      {bars.map(bar => {
        const cells = barCells(bar.value, max)
        const isBase = row === 2 && bar.value === 0 && !bar.isFuture

        return (
          <Text color={isBase ? LINE : barColor(bar)}>{`${(isBase ? '▁' : cells[row]!).repeat(barWidth)}${' '.repeat(gap)}`}</Text>
        )
      })}
    </Box>
  ))

  let labels
  if (tab === 'month') {
    const first = shortDate(addDays(today, -(bars.length - 1)))
    const last = 'Today'
    const room = bars.length * slot
    labels =
      room >= first.length + last.length + 1 ? (
        <Box flexDirection="row" width={width}>
          <Text color={MUTED}>{first.padEnd(room - last.length)}</Text>
          <Text color={GOLD}>{last}</Text>
        </Box>
      ) : (
        <Text color={MUTED}>{clip(first, width)}</Text>
      )
  } else {
    labels = (
      <Box flexDirection="row" width={width}>
        {bars.map(bar => (
          <Text color={bar.isCurrent ? GOLD : MUTED}>{(slot >= 2 ? bar.label : bar.label.charAt(0)).slice(0, slot).padEnd(slot)}</Text>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {drawSection(kit, width, CHART_HEADING[tab])}
      {rows}
      {labels}
    </Box>
  )
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  // Typed prompts waiting for their turn, and the turn being counted.
  let pending: { text: string; turnId?: string }[] = []
  let current: { turnId: string; uses: ToolUse[] } | null = null
  let lastCommandAt = -Infinity

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'report',
        description: 'Open the Work Report: tasks Claude finished and the time it saved. Also: week, month, year, settings',
        argumentHint: '[today | week | month | year | settings]',
      })
    } catch {
      // registration refused; counting still works
    }
    try {
      await loadSettings($)
      await loadDays($)
    } catch {
      // nothing kept yet
    }

    return next(e)
  })

  on('command.run', { command: 'report' }, async ($, e) => {
    try {
      const words = e.args.trim().split(/\s+/).filter(Boolean)
      const first = (words[0] ?? '').toLowerCase()

      if (first === 'settings') {
        const result = applySetting(words.slice(1).join(' '), await getSettings($))
        if (result.settings !== undefined) {
          await $.state.set(SETTINGS, result.settings)
          await $.store.set('settings', result.settings)
        }

        return { text: result.text }
      }

      const tab = TABS.find(one => one === first)
      if (first !== '' && tab === undefined) {
        return { text: 'Try /report, /report week, /report month, /report year or /report settings.' }
      }
      if (tab !== undefined) await $.state.set(TAB, tab)
      void openReport($).catch(() => undefined)

      return { text: 'Work Report is open. Hours and dollars are estimates.' }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  // A slash command that expands into a prompt is not a typed request.
  on('command.run', async ($, e, next) => {
    lastCommandAt = await $.clock.now()

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const isCommand = (await $.clock.now()) - lastCommandAt < 1500
    const origin = e.origin
    const isTyped =
      !isCommand &&
      isTypedPrompt({ originKind: origin.kind, asUser: origin.kind === 'plugin' ? origin.asUser : undefined, text: e.text })
    const entry = { text: e.text, turnId: e.turnId }
    if (isTyped) pending = [...pending, entry].slice(-20)

    const result = await next(e)
    if (result.drop !== undefined) pending = pending.filter(one => one !== entry)

    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    // The prompt the turn starts with, else the oldest typed while idle.
    const match = pending.find(one => one.text === e.text) ?? (e.text === '' ? undefined : pending.find(one => one.turnId === undefined))
    if (match !== undefined) {
      pending = pending.filter(one => one !== match)
      current = { turnId: e.turnId, uses: [] }
    } else {
      current = null
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Helper agents' tool calls count toward the request that started them.
  on('tool.call', ($, e, next) => {
    if (current !== null && current.uses.length < 300) {
      current.uses.push({ tool: String(e.tool), paths: pathsOf(e as unknown as Record<string, unknown>) })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && current !== null && current.turnId === e.turnId) {
      const task = current
      current = null
      if (e.reason === 'answer') {
        try {
          const model = modelName(e.usage?.model ?? (await $.session.model()))
          await record($, kindOf(task.uses), model)
        } catch {
          // a lost count is better than a stuck turn
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The status bar button: the mode labels as the engine has them, then a
  // quiet button with today's count that opens the report.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const days = await getDays($)
    const count = tasksOn(days[await todayOf($)])
    const label = count === 0 ? 'Work report' : `Work report · ${count} today`
    const modes = e.props.modes.join(' & ')

    return (
      <Box flexDirection="row">
        {modes !== '' && <Text dimColor>{`${modes}  `}</Text>}
        <Button key="open-work-report" plain onPress={act(() => openReport($))}>
          <Text dimColor>{label}</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const kit: Kit = { Box: table.Box, Text: table.Text, Button: table.Button }
    const { Box, Text } = kit
    const width = Math.max(10, e.props.bodyColumns)

    const tab = await getTab($)
    const days = await getDays($)
    const settings = await getSettings($)
    const today = await todayOf($)

    const { name, dates } = titleOf(tab, today)
    const totals = sumDays(days, daysOf(tab, today))
    const bars = barsOf(tab, days, today)
    const hasChart = bars.some(bar => bar.value > 0)

    return (
      <Box flexDirection="column" width={width}>
        {drawTabs($, kit, width, tab)}
        {drawTitle(kit, width, name, dates)}
        {totals.tasks === 0 ? (
          <Box flexDirection="column" marginTop={1} width={width}>
            {wrap(emptyText(tab), width).map(line => (
              <Text color={MUTED}>{line}</Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column" width={width}>
            {drawTiles(kit, width, totals, settings)}
            {wrap(`Estimates: minutes saved per task at $${settings.rate} an hour.`, width).map(line => (
              <Text color={MUTED}>{line}</Text>
            ))}
            {drawKinds(kit, width, totals, settings)}
            {drawModels(kit, width, totals)}
          </Box>
        )}
        {hasChart && drawChart(kit, width, tab, bars, today)}
        {hasChart && (
          <Box flexDirection="column" marginTop={1} width={width}>
            {wrap(summaryOf(tab, days, today), width).map(line => (
              <Text color={(tab === 'today' || tab === 'week') && streak(days, today) > 0 ? GREEN : TEXT}>{line}</Text>
            ))}
          </Box>
        )}
        <Box marginTop={1} width={width}>
          {drawChips(kit, [{ key: 'close', label: 'Close', tone: 'quiet', onPress: act(() => $.ui.close({ id: PANE })) }], width)}
        </Box>
      </Box>
    )
  })
}
