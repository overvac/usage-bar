import { atom, read, update } from 'claude-code'
import type { Color, Register, SessionRateLimit } from 'claude-code'

import type { Limit, Usage } from '../types'

// The bar above the prompt: session cost, context window, and the 5-hour and
// weekly plan limits with their reset countdowns, then how long ago any of
// those figures last changed. `/usage-bar` hides and shows it.

const usage = atom({ plugin: 'usage-bar', key: 'usage' } as const, null)
const isHidden = atom({ plugin: 'usage-bar', key: 'isHidden' } as const, false)

const HIDDEN_KEY = 'hidden'

// Cell colours along a bar, from empty to full: green through amber to red.
const GRADIENT = ['#87d787', '#87d787', '#afd787', '#d7d787', '#ffd787', '#ffd75f', '#ffaf5f', '#ff875f', '#ff5f5f', '#ff5f5f']
const LABEL = '#8787af'
const COST = '#87d7ff'
const MUTED: Color = 'inactive'
const FAINT: Color = 'subtle'

const MIN_WIDTH = 4
const MAX_WIDTH = 30
const DEFAULT_WIDTH = 10
const SEP = '  ·  '

const WINDOWS = [
  { kind: 'five_hour', icon: '◷', label: '5h' },
  { kind: 'seven_day', icon: '◫', label: '7d' },
] as const

/** One run of text in one style. */
type Run = { text: string; color?: Color; isBold?: boolean; isDim?: boolean }

/** A segment of the bar: its runs, with a hole where a bar of `width` cells goes. */
type Segment = { runs: (width: number) => Run[]; hasBar: boolean }

function tone(pct: number): string {
  return GRADIENT[Math.min(GRADIENT.length - 1, Math.floor((pct / 100) * GRADIENT.length))]
}

/** The bar's cells as runs: filled cells shaded along the gradient, then the track. */
function cells(pct: number, width: number): Run[] {
  if (width === 0) {
    return []
  }
  const filled = (pct / 100) * width
  const full = Math.floor(filled)
  const isHalf = filled - full >= 0.5 && full < width
  const runs: Run[] = []
  for (let i = 0; i < full; i++) {
    runs.push({ text: '━', color: GRADIENT[Math.floor((i * GRADIENT.length) / width)] })
  }
  if (isHalf) {
    runs.push({ text: '╸', color: GRADIENT[Math.floor((full * GRADIENT.length) / width)] })
  }
  runs.push({ text: '━'.repeat(width - full - (isHalf ? 1 : 0)), color: FAINT })
  runs.push({ text: ' ' })

  return runs
}

function meter(icon: string, label: string, percent: number): Segment {
  const pct = Math.max(0, Math.min(100, percent))
  const figure = `${Math.round(pct)}%`.padStart(3)

  return {
    hasBar: true,
    runs: width => [
      { text: `${icon} ${label} `, color: LABEL },
      ...cells(pct, width),
      { text: figure, color: tone(pct), isBold: true },
    ],
  }
}

function countdown(resetsAt: string | undefined, now: number): Run[] {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) {
    return []
  }
  const left = Math.max(0, Math.floor((at - now) / 1000))
  const d = Math.floor(left / 86400)
  const h = Math.floor((left % 86400) / 3600)
  const m = Math.floor((left % 3600) / 60)
  const text = d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`

  return [
    { text: ' ↻ ', color: MUTED, isDim: true },
    { text, color: MUTED },
  ]
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 5) {
    return 'just now'
  }
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const m = Math.floor(seconds / 60)
  if (m < 60) {
    return m < 10 ? `${m}m ${String(seconds % 60).padStart(2, '0')}s ago` : `${m}m ago`
  }

  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m ago`
}

function segments(figures: Usage, now: number): Segment[] {
  const list: Segment[] = []
  if (figures.costUsd !== undefined) {
    const text = `$${figures.costUsd.toFixed(2)}`
    list.push({ hasBar: false, runs: () => [{ text, color: COST, isBold: true }] })
  }
  if (figures.contextPercent !== undefined) {
    list.push(meter('◔', 'ctx', figures.contextPercent))
  }
  for (const { kind, icon, label } of WINDOWS) {
    const limit = figures.limits.find(one => one.kind === kind)
    if (limit) {
      const bar = meter(icon, label, limit.percentUsed)
      const tail = countdown(limit.resetsAt, now)
      list.push({ hasBar: true, runs: width => [...bar.runs(width), ...tail] })
    }
  }
  const since = now - figures.changedAt
  // Padded to its longest form so the bars don't resize as it ticks.
  const text = ago(since).padEnd(10)
  list.push({
    hasBar: false,
    runs: () => [
      { text: '● ', color: since < 60_000 ? GRADIENT[0] : FAINT },
      { text, color: MUTED },
    ],
  })

  return list
}

function length(runs: Run[]): number {
  return runs.reduce((sum, run) => sum + [...run.text].length, 0)
}

/** The whole line as runs, its bars stretched to fill `columns`. */
export function layout(figures: Usage, now: number, columns: number | undefined): Run[] {
  const list = segments(figures, now)
  const bars = list.filter(one => one.hasBar).length
  let width = DEFAULT_WIDTH
  if (columns !== undefined && bars > 0) {
    const fixed = list.reduce((sum, one) => sum + length(one.runs(0)), 0) + SEP.length * (list.length - 1)
    // Each bar also brings a space between it and its percentage; one column spare.
    const fitted = Math.min(MAX_WIDTH, Math.floor((columns - 1 - fixed - bars) / bars))
    width = fitted >= MIN_WIDTH ? fitted : 0
  }
  const runs: Run[] = []
  list.forEach((one, i) => {
    if (i > 0) {
      runs.push({ text: SEP, color: FAINT })
    }
    runs.push(...one.runs(width))
  })
  const last = runs[runs.length - 1]
  last.text = last.text.trimEnd()

  return runs
}

function limitsOf(rateLimits: SessionRateLimit[]): Limit[] {
  return rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
}

function hasFigures(figures: Omit<Usage, 'changedAt'>): boolean {
  return figures.costUsd !== undefined || figures.contextPercent !== undefined || figures.limits.length > 0
}

export const register: Register = on => {
  let isDrawn = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bar',
      description: 'Hide or show the usage bar above the prompt',
    })
    const hidden = (await $.store.get(HIDDEN_KEY)) === true
    await update($, isHidden, () => hidden)

    const { context, rateLimits, cost } = await $.session.usage()
    const figures = { costUsd: cost?.usd, contextPercent: context.percent, limits: limitsOf(rateLimits) }
    if (hasFigures(figures)) {
      const now = await $.clock.now()
      await update($, usage, () => ({ ...figures, changedAt: now }))
    }

    // Keeps the countdowns and "ago" moving while the session is idle.
    $.clock.every(1000, () => {
      if (isDrawn) {
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const figures = { costUsd: e.cost?.usd, contextPercent: e.context.percent, limits: limitsOf(e.rateLimits) }
    await update($, usage, () => ({ ...figures, changedAt: now }))

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    await $.store.set(HIDDEN_KEY, hidden)

    return { text: hidden ? 'Usage bar hidden. Run /usage-bar to show it again.' : 'Usage bar shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    isDrawn = false
    const figures = await read($, usage)
    if (e.props.hasSurvey || figures === null || (await read($, isHidden))) {
      return next(e)
    }
    const runs = layout(figures, await $.clock.now(), e.props.bodyColumns)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    isDrawn = true
    const line = (
      <Text wrap="truncate-end">
        {runs.map(run => (
          <Text color={run.color} weight={run.isBold ? 'bold' : undefined} dimColor={run.isDim}>
            {run.text}
          </Text>
        ))}
      </Text>
    )

    return below ? (
      <Box flexDirection="column">
        {below}
        {line}
      </Box>
    ) : (
      line
    )
  })
}
