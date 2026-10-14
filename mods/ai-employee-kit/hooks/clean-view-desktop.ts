// Clean View's band in the desktop app. The desktop sets text in a
// proportional font and draws its own buttons, so cell-sized rows drift; the
// band is one SVG sized in pixels instead. The sweep on a step that has not
// reported yet is an SVG animation, so it moves with no redraws.

import type { CleanViewChecklist } from '../types'
import { headerOf, rowsOf } from './clean-view-logic'

const GOLD = '#F2C46D'
const CORAL = '#F0876A'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const RED = '#F47067'
const INK = '#0D1117'

const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', sans-serif`

export type Band = { source: string; alt: string; isAnimated: boolean; height: number }

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// About how wide a run of text sets, for laying things beside it.
const textWidth = (text: string, size: number, isBold = false) => text.length * size * (isBold ? 0.6 : 0.54)

// The desktop reports fewer columns than it shows: about 13 pixels each. An
// SVG wider than its slot is scaled down to fit, never cut.
export const pixelsFor = (columns: number): number => Math.max(300, Math.round(columns * 13))

const fit = (text: string, room: number, size: number, isBold = false) => {
  if (textWidth(text, size, isBold) <= room) return text
  const keep = Math.max(1, Math.floor(room / (size * (isBold ? 0.6 : 0.54))) - 1)

  return `${text.slice(0, keep)}…`
}

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(SANS)}">` +
  `<defs><linearGradient id="cv-sweep" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${GOLD}" stop-opacity="0"/><stop offset="0.5" stop-color="${GOLD}" stop-opacity="0.9"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></linearGradient>` +
  `<linearGradient id="cv-fill" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${CORAL}"/><stop offset="1" stop-color="${GOLD}"/></linearGradient></defs>${body}</svg>`

const HEADER_TONE: Record<string, string> = { stuck: AMBER, stopped: MUTED, done: GREEN }

const headerSvg = (list: CleanViewChecklist, width: number, now: number) => {
  const header = headerOf(list, now, 'you pressed Stop')
  if (header.badge !== null) {
    const badgeWidth = Math.round(textWidth(header.badge, 12, true) + 20)

    return (
      `<rect x="0" y="4" width="${badgeWidth}" height="22" rx="11" fill="${AMBER}"/>` +
      `<text x="${badgeWidth / 2}" y="19" font-size="12" font-weight="700" fill="${INK}" text-anchor="middle">${esc(header.badge)}</text>` +
      `<text x="${badgeWidth + 10}" y="20" font-size="14" fill="${TEXT}">${esc(fit(header.text, width - badgeWidth - 10, 14))}</text>`
    )
  }
  const color = HEADER_TONE[header.kind] ?? TEXT

  return `<text x="0" y="20" font-size="14" font-weight="600" fill="${color}">${esc(fit(header.text, width, 14, true))}</text>`
}

// One full row per step: its mark, its name, a meter and a label.
export const bandSvg = (list: CleanViewChecklist, width: number, now: number): Band => {
  const header = headerSvg(list, width, now)
  if (list.phase === 'done' && list.isCollapsed) {
    return { source: svg(width, 28, header), alt: headerOf(list, now, 'you pressed Stop').text, isAnimated: false, height: 28 }
  }
  const rows = rowsOf(list)
  const meterWidth = 120
  const labelWidth = 64
  const meterX = width - labelWidth - meterWidth - 12
  const nameX = 26
  const nameRoom = Math.max(40, meterX - nameX - 12)
  let isAnimated = false
  let body = header + `<line x1="0" y1="34.5" x2="${width}" y2="34.5" stroke="${LINE}"/>`
  rows.forEach((row, i) => {
    const one = list.tasks[i]!
    const y = 58 + i * 28
    const markColor = row.mark === '✓' ? GREEN : row.mark === '‖' ? AMBER : row.mark === '▶' ? GOLD : MUTED
    const nameColor = row.tone === 'active' ? TEXT : MUTED
    body += `<text x="2" y="${y}" font-size="13" fill="${markColor}">${row.mark}</text>`
    body += `<text x="${nameX}" y="${y}" font-size="14" fill="${nameColor}"${row.tone === 'active' ? ' font-weight="600"' : ''}>${esc(fit(row.name, nameRoom, 14, row.tone === 'active'))}</text>`
    body += `<rect x="${meterX}" y="${y - 8}" width="${meterWidth}" height="6" rx="3" fill="${LINE}"/>`
    if (one.status === 'done') {
      body += `<rect x="${meterX}" y="${y - 8}" width="${meterWidth}" height="6" rx="3" fill="${GREEN}" fill-opacity="0.75"/>`
    } else if (one.status === 'active' && one.hasReported) {
      const filled = Math.round((one.percent / 100) * meterWidth)
      if (filled > 0) body += `<rect x="${meterX}" y="${y - 8}" width="${filled}" height="6" rx="3" fill="url(#cv-fill)"/>`
    } else if (one.status === 'active' && list.phase === 'working') {
      isAnimated = true
      body +=
        `<svg x="${meterX}" y="${y - 8}" width="${meterWidth}" height="6"><rect x="-48" y="0" width="48" height="6" rx="3" fill="url(#cv-sweep)">` +
        `<animate attributeName="x" from="-48" to="${meterWidth}" dur="1.6s" repeatCount="indefinite"/></rect></svg>`
    }
    body += `<text x="${width}" y="${y}" font-size="12" fill="${row.tone === 'active' ? TEXT : MUTED}" text-anchor="end">${esc(row.label)}</text>`
  })
  const height = 58 + (rows.length - 1) * 28 + 12
  const alt = [headerOf(list, now, 'you pressed Stop').text, ...rows.map(row => `${row.mark} ${row.name} ${row.label}`)].join('. ')

  return { source: svg(width, height, body), alt, isAnimated, height }
}
