// The desktop app's drawing. It sets text in a proportional font, so rows
// sized in character cells drift; the header, the tiles, the breakdowns and
// the chart are drawn here as SVG instead, sized in pixels.

import type { Kind, Settings, Tab } from '../types'
import { KINDS, KIND_LABEL, hoursText, kindMinutes, minutesSaved, moneyText, projectRows } from './logic'
import type { Bar, Totals } from './logic'

const GOLD = '#F2C46D'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'

const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', sans-serif`

export type Drawing = { source: string; alt: string }

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The pixel width to draw at. The desktop reports fewer columns than it
// shows; a column is about 13 pixels there. An SVG drawn wider than the pane
// is scaled down to fit, never cut.
export const pixelsFor = (columns: number): number => Math.max(260, Math.round(columns * 13))

// About how wide a run of text sets, for laying things beside it.
const textWidth = (text: string, size: number, isBold = false) => text.length * size * (isBold ? 0.64 : 0.56)

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(SANS)}">${body}</svg>`

const label = (x: number, y: number, text: string, size: number, fill: string, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(text)}</text>`

// A small muted heading in capitals, then a hairline to the edge.
const heading = (width: number, y: number, text: string) => {
  const caps = text.toUpperCase()
  const end = Math.min(width, caps.length * 11 * 0.74 + 12)

  return (
    label(0, y, caps, 11, MUTED, ` letter-spacing="0.08em" font-weight="600"`) +
    (end < width ? `<line x1="${end.toFixed(1)}" y1="${y - 4}" x2="${width}" y2="${y - 4}" stroke="${LINE}" stroke-width="1"/>` : '')
  )
}

// The title in bold capitals, its dates on the right, and under it a gold
// rule as wide as the title that runs on as a dim hairline to the edge.
export const headerSvg = (width: number, name: string, dates: string): Drawing => {
  const titleWidth = Math.min(width, textWidth(name, 16, true) * 1.08)
  const hasDates = titleWidth + 16 + textWidth(dates, 13) <= width
  const body =
    `<text x="0" y="20" font-size="16" font-weight="700" letter-spacing="0.06em" fill="${TEXT}" textLength="${titleWidth.toFixed(1)}" lengthAdjust="spacing">${esc(name)}</text>` +
    (hasDates ? label(width, 20, dates, 13, MUTED, ` text-anchor="end"`) : '') +
    `<line x1="0" y1="33" x2="${titleWidth.toFixed(1)}" y2="33" stroke="${GOLD}" stroke-width="2"/>` +
    `<line x1="${titleWidth.toFixed(1)}" y1="33" x2="${width}" y2="33" stroke="${LINE}" stroke-width="1"/>`

  return { source: svg(width, 38, body), alt: `${name}, ${dates}` }
}

const TILE_MIN = 168
const TILE_GAP = 12

export const tilesAcross = (width: number): number => {
  for (let n = 3; n > 1; n--) if (n * TILE_MIN + (n - 1) * TILE_GAP <= width) return n

  return 1
}

// Three rounded tiles with big numerals; fewer side by side as it narrows.
// A number too wide for the big size is set smaller, still bold.
export const tilesSvg = (width: number, totals: Totals, settings: Settings): Drawing => {
  const minutes = minutesSaved(totals, settings)
  const tiles = [
    { big: hoursText(minutes), plain: `${hoursText(minutes)} h`, label: 'EST. HOURS SAVED', color: GOLD },
    { big: totals.tasks.toLocaleString('en-US'), plain: totals.tasks.toLocaleString('en-US'), label: 'TASKS DONE', color: TEXT },
    { big: moneyText(minutes, settings.rate, true), plain: moneyText(minutes, settings.rate, true), label: 'EST. VALUE', color: GREEN },
  ]
  const across = tilesAcross(width)
  const tileWidth = Math.floor((width - (across - 1) * TILE_GAP) / across)
  const tileHeight = 96
  const room = tileWidth - 32
  let body = ''
  tiles.forEach((tile, i) => {
    const x = (i % across) * (tileWidth + TILE_GAP)
    const y = Math.floor(i / across) * (tileHeight + TILE_GAP)
    const isBig = textWidth(tile.big, 38, true) <= room
    const size = isBig ? 38 : Math.max(14, Math.min(24, Math.floor(room / (tile.plain.length * 0.64))))
    body +=
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${tileWidth - 1}" height="${tileHeight - 1}" rx="12" fill="none" stroke="${LINE}"/>` +
      `<text x="${x + 16}" y="${y + 54}" font-size="${size}" font-weight="700" fill="${tile.color}" style="font-variant-numeric: tabular-nums">${esc(isBig ? tile.big : tile.plain)}</text>` +
      label(x + 16, y + 78, tile.label, 11, MUTED, ` letter-spacing="0.08em" font-weight="600"`)
  })
  const rows = Math.ceil(tiles.length / across)
  const alt = tiles.map(tile => `${tile.label.toLowerCase()} ${tile.plain}`).join(', ')

  return { source: svg(width, rows * tileHeight + (rows - 1) * TILE_GAP, body), alt }
}

export type BarRow = { label: string; value: number; color: string; figures: string[] }

// A heading, then one row per item: its name, a colored bar on a dim track,
// and its figures right-aligned.
export const barRowsSvg = (width: number, title: string, rows: BarRow[]): Drawing => {
  const labelWidth = Math.min(170, Math.round(width * 0.32))
  const figureWidth = rows[0] !== undefined && rows[0].figures.length > 1 ? 112 : 44
  const trackStart = labelWidth
  const trackEnd = width - figureWidth - 12
  const max = Math.max(0, ...rows.map(row => row.value))
  let body = heading(width, 12, title)
  rows.forEach((row, i) => {
    const y = 36 + i * 26
    const isZero = row.value === 0
    const track = Math.max(0, trackEnd - trackStart)
    const filled = max <= 0 || isZero ? 0 : Math.max(4, (row.value / max) * track)
    body += label(0, y, row.label, 13, isZero ? MUTED : TEXT)
    if (track >= 24) {
      body += `<rect x="${trackStart}" y="${y - 7}" width="${track.toFixed(1)}" height="5" rx="2.5" fill="${LINE}"/>`
      if (filled > 0) body += `<rect x="${trackStart}" y="${y - 7}" width="${filled.toFixed(1)}" height="5" rx="2.5" fill="${row.color}"/>`
    }
    // The last figure sits at the edge; any before it, 64 pixels in from there.
    row.figures.forEach((figure, j) => {
      const x = width - (row.figures.length - 1 - j) * 64
      body += label(x, y, figure, 13, isZero ? MUTED : TEXT, ` text-anchor="end" style="font-variant-numeric: tabular-nums"`)
    })
  })
  const alt = `${title}: ${rows.map(row => `${row.label} ${row.figures.join(' ')}`).join(', ')}`

  return { source: svg(width, 36 + rows.length * 26 - 12, body), alt }
}

export const kindRows = (totals: Totals, settings: Settings, colors: Record<Kind, string>): BarRow[] =>
  KINDS.map(kind => ({
    label: KIND_LABEL[kind],
    value: kindMinutes(totals, kind, settings),
    color: colors[kind],
    figures: [String(totals.kinds[kind]), `${hoursText(kindMinutes(totals, kind, settings))} h`],
  }))

// One row per project: its tasks and estimated hours, hours added by hand
// included.
export const projectBarRows = (totals: Totals, settings: Settings, colors: readonly string[]): BarRow[] =>
  projectRows(totals, settings).map((row, i) => ({
    label: row.name,
    value: row.minutes,
    color: colors[i % colors.length]!,
    figures: [String(row.tasks), `${hoursText(row.minutes)} h`],
  }))

// The chart: a heading, bars on a plot 64 pixels tall, labels under them.
// The current day or month is gold; months still to come are left empty.
export const chartSvg = (width: number, tab: Tab, title: string, bars: Bar[], first: string): Drawing => {
  const slot = width / bars.length
  const barWidth = Math.max(2, Math.min(28, slot * 0.62))
  const max = Math.max(0, ...bars.map(bar => bar.value))
  const base = 92
  const plot = 64
  let body = heading(width, 12, title)
  bars.forEach((bar, i) => {
    const x = i * slot + (slot - barWidth) / 2
    if (bar.isFuture) return
    if (bar.value === 0) {
      body += `<rect x="${x.toFixed(1)}" y="${base - 2}" width="${barWidth.toFixed(1)}" height="2" rx="1" fill="${LINE}"/>`

      return
    }
    const tall = Math.max(4, (bar.value / max) * plot)
    const fill = bar.isCurrent ? GOLD : MUTED
    body += `<rect x="${x.toFixed(1)}" y="${(base - tall).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${tall.toFixed(1)}" rx="${Math.min(3, barWidth / 2).toFixed(1)}" fill="${fill}"${bar.isCurrent ? '' : ' fill-opacity="0.6"'}/>`
  })
  if (tab === 'month') {
    body += label(0, base + 18, first, 11, MUTED) + label(width, base + 18, 'Today', 11, GOLD, ` text-anchor="end"`)
  } else {
    bars.forEach((bar, i) => {
      const x = i * slot + slot / 2
      body += label(Number(x.toFixed(1)), base + 18, bar.label, 11, bar.isCurrent ? GOLD : MUTED, ` text-anchor="middle"`)
    })
  }
  const alt = `${title}: ${bars.filter(bar => !bar.isFuture).map(bar => `${bar.label} ${bar.value}`).join(', ')}`

  return { source: svg(width, base + 24, body), alt }
}
