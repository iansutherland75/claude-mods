// The Agents pane's drawing. The desktop app sets text in a proportional font,
// so a card there is one SVG sized in pixels, as work-report draws its charts.
// The terminal gets rows of text with a block bar.

import type { AgentCard } from '../types'
import { bareName, clip, colorOf, isLive, modelLabel, progressOf, routeText, statusText } from './logic'

const CARD = '#161B22'
const LINE = '#262B33'
const TRACK = '#21262D'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const RED = '#F85149'

const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', sans-serif`

export type Drawing = { source: string; alt: string }

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The desktop reports fewer columns than it shows; a column is about 13 pixels
// there. An SVG drawn wider than the pane is scaled down to fit, never cut.
export const pixelsFor = (columns: number): number => Math.max(280, Math.round(columns * 13))

// About how many characters fit in a run of pixels at a font size.
const fits = (pixels: number, size: number, isBold = false) => Math.max(4, Math.floor(pixels / (size * (isBold ? 0.62 : 0.55))))

const label = (x: number, y: number, text: string, size: number, fill: string, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(text)}</text>`

const HEIGHT = 112

// One card: a coloured edge, the type and task, a model chip, how the model
// was chosen, the progress bar, and what it is doing or how it ended.
export const cardSvg = (width: number, card: AgentCard): Drawing => {
  const color = card.stage === 'denied' ? RED : colorOf(card.model)
  const chip = modelLabel(card.model).toUpperCase()
  const chipWidth = Math.round(chip.length * 7.4 + 18)
  const left = 18
  const inner = width - left - 14
  const type = bareName(card.type)
  const typeWidth = Math.min(inner * 0.45, type.length * 13 * 0.62 + 4)
  const taskRoom = inner - typeWidth - chipWidth - 16
  const barWidth = inner
  const fill = Math.round(barWidth * progressOf(card))
  const isRunning = isLive(card)
  const isDim = !isRunning

  // A running bar breathes, so a quiet agent still looks alive.
  const pulse = isRunning
    ? `<animate attributeName="opacity" values="1;0.55;1" dur="1.6s" repeatCount="indefinite"/>`
    : ''

  const body =
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${HEIGHT - 1}" rx="10" fill="${CARD}" stroke="${LINE}"/>` +
    `<rect x="0" y="0" width="5" height="${HEIGHT}" rx="2.5" fill="${color}"/>` +
    label(left, 26, clip(type, fits(typeWidth, 13, true)), 13, TEXT, ` font-weight="700"`) +
    label(left + typeWidth + 8, 26, clip(card.task, fits(taskRoom, 13)), 13, isDim ? MUTED : TEXT) +
    `<rect x="${width - 14 - chipWidth}" y="11" width="${chipWidth}" height="21" rx="10.5" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.6"/>` +
    label(width - 14 - chipWidth / 2, 26, chip, 11, color, ` text-anchor="middle" font-weight="700" letter-spacing="0.06em"`) +
    label(left, 50, clip(routeText(card), fits(inner, 12)), 12, MUTED) +
    `<rect x="${left}" y="62" width="${barWidth}" height="8" rx="4" fill="${TRACK}"/>` +
    (fill > 0 ? `<rect x="${left}" y="62" width="${fill}" height="8" rx="4" fill="${color}">${pulse}</rect>` : '') +
    label(left, 94, clip(statusText(card), fits(inner, 12)), 12, card.stage === 'denied' || card.stage === 'stopped' ? RED : TEXT)

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" font-family="${esc(SANS)}">${body}</svg>`,
    alt: `${type} on ${modelLabel(card.model)}: ${card.task}. ${routeText(card)}. ${statusText(card)}.`,
  }
}

// The terminal's bar: blocks for the share done.
export const barText = (columns: number, card: AgentCard): string => {
  const width = Math.max(6, columns)
  const full = Math.round(width * progressOf(card))

  return '█'.repeat(full) + '░'.repeat(width - full)
}

// ---------------------------------------------------------------- band

// The band above the prompt shows this many rows; the rest are counted.
export const BAND_ROWS = 6

// The rows the band shows: every live agent first, then the latest finished
// ones, each group in the order they started.
export const bandCards = (cards: readonly AgentCard[]): { shown: AgentCard[]; more: number } => {
  const live = cards.filter(isLive)
  const ended = cards.filter(card => !isLive(card))
  const room = Math.max(0, BAND_ROWS - live.length)
  const shown = [...live.slice(0, BAND_ROWS), ...(room > 0 ? ended.slice(-room) : [])]

  return { shown, more: cards.length - shown.length }
}

// A band row's status, shorter than a card's.
export const bandStatus = (card: AgentCard): string => {
  const calls = `${card.tools} call${card.tools === 1 ? '' : 's'}`
  if (card.stage === 'routing') return 'Asking Jev…'
  if (card.stage === 'denied') return 'Refused'
  if (card.stage === 'running') return card.lastTool ? `${calls} · ${card.lastTool}` : 'Started'
  const time = card.endedAt !== undefined ? ` · ${Math.round((card.endedAt - card.startedAt) / 1000)} s` : ''

  return `${card.stage === 'done' ? 'Done' : 'Stopped'}${time} · ${calls}`
}

const ROW = 28
const BAND_HEAD = 22

// The whole band as one SVG: a heading, then one row an agent with a dot and
// chip in the model colour, the type and task, a thin bar and the status.
export const bandSvg = (width: number, cards: readonly AgentCard[], heading: string): Drawing => {
  const { shown, more } = bandCards(cards)
  const isWide = width >= 560
  const barWidth = Math.round(Math.min(120, width * 0.16))
  const chipWidth = 64
  // On a narrow band the status gives way first, so the type keeps about 60
  // pixels left of the chip and nothing overlaps.
  const fixed = 20 + 60 + 6 + chipWidth + 12 + barWidth + 12
  const statusWidth = Math.max(40, Math.min(280, Math.round(width * (isWide ? 0.3 : 0.38)), width - fixed))
  const chipX = width - statusWidth - 12 - barWidth - 12 - chipWidth
  const typeWidth = Math.max(24, Math.min(130, Math.round(width * 0.2), chipX - 26))
  const taskX = 20 + typeWidth + 6
  const taskRoom = chipX - 10 - taskX
  const height = BAND_HEAD + shown.length * ROW + 4

  const rows = shown
    .map((card, i) => {
      const y = BAND_HEAD + i * ROW
      const mid = y + ROW / 2
      const color = card.stage === 'denied' ? RED : colorOf(card.model)
      const fill = Math.round(barWidth * progressOf(card))
      const barX = chipX + chipWidth + 12
      const isEnded = !isLive(card)
      const pulse = isEnded ? '' : `<animate attributeName="opacity" values="1;0.55;1" dur="1.6s" repeatCount="indefinite"/>`
      const statusColor = card.stage === 'denied' || card.stage === 'stopped' ? RED : isEnded ? MUTED : TEXT

      return (
        `<circle cx="8" cy="${mid}" r="4" fill="${color}"${isEnded ? ' fill-opacity="0.5"' : ''}/>` +
        label(20, mid + 4.5, clip(bareName(card.type), fits(typeWidth, 13, true)), 13, isEnded ? MUTED : TEXT, ` font-weight="700"`) +
        (taskRoom > 40 ? label(taskX, mid + 4.5, clip(card.task, fits(taskRoom, 13)), 13, MUTED) : '') +
        `<rect x="${chipX}" y="${mid - 9}" width="${chipWidth}" height="18" rx="9" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.6"/>` +
        label(chipX + chipWidth / 2, mid + 4, modelLabel(card.model).toUpperCase(), 10, color, ` text-anchor="middle" font-weight="700" letter-spacing="0.06em"`) +
        `<rect x="${barX}" y="${mid - 3}" width="${barWidth}" height="6" rx="3" fill="${TRACK}"/>` +
        (fill > 0 ? `<rect x="${barX}" y="${mid - 3}" width="${fill}" height="6" rx="3" fill="${color}">${pulse}</rect>` : '') +
        label(width, mid + 4.5, clip(bandStatus(card), fits(statusWidth, 12)), 12, statusColor, ` text-anchor="end"`)
      )
    })
    .join('')

  const head =
    label(0, 14, 'AGENTS', 11, MUTED, ` font-weight="600" letter-spacing="0.08em"`) +
    label(62, 14, more > 0 ? `${heading} · ${more} more in /skill-router pane` : heading, 11, MUTED)

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(SANS)}">${head}${rows}</svg>`,
    alt: [`Agents: ${heading}.`, ...shown.map(card => `${bareName(card.type)} on ${modelLabel(card.model)}, ${bandStatus(card)}.`)].join(' '),
  }
}

// A terminal band row: dot, type, model, a short bar and the status.
export const bandLine = (columns: number, card: AgentCard): string => {
  const bar = barText(10, card)

  return clip(`● ${bareName(card.type)} · ${modelLabel(card.model)}  ${bar}  ${bandStatus(card)}`, Math.max(20, columns))
}

export { MUTED, TEXT }
