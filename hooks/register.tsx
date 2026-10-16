// Usage Bar: a row above the prompt showing the session's cost, the context
// window, and the 5-hour and weekly plan limits with their reset countdowns,
// then how long ago any of those figures last changed.
//
// What it touches, all through Claude Code's own plugin API:
//   - reads the usage figures Claude Code already keeps ($.session.usage and
//     the session.measure event), the same ones a status line receives;
//   - reads the `theme` setting, to pick backgrounds that suit it;
//   - stores one value of its own, whether the bar is hidden ($.store);
//   - registers the /usage-bar command and draws the row.
// It makes no network requests, reads or writes no files, runs no commands,
// and sends nothing to the model.

import { atom, read, update } from 'claude-code'
import type { Color, Elements, Register, SessionMeasureInput } from 'claude-code'

import type { Limit, Usage } from '../types'

const usage = atom({ plugin: 'usage-bar', key: 'usage' } as const, null)
const isHidden = atom({ plugin: 'usage-bar', key: 'isHidden' } as const, false)

/** The $.store key that remembers /usage-bar's choice across sessions. */
const HIDDEN_KEY = 'hidden'

// Cell colours along a bar, from empty to full: green through amber to red.
const GRADIENT = ['#87d787', '#87d787', '#afd787', '#d7d787', '#ffd787', '#ffd75f', '#ffaf5f', '#ff875f', '#ff5f5f', '#ff5f5f']
const LABEL = '#8787af'
const COST = '#87d7ff'
const MUTED: Color = 'inactive'
const FAINT: Color = 'subtle'
// The empty track up to the pace point, a step lighter than the rest.
const PACE: Color = 'inactive'
// Backgrounds, by the theme's lightness: behind a segment whose figure has
// just changed, and behind the details line a hovered segment shows.
const SHADES = {
  dark: { flash: '#2c313c', details: '#22252d' },
  light: { flash: '#e3e7ef', details: '#eef0f4' },
}
const FLASH_MS = 2000

const MIN_WIDTH = 4
const DEFAULT_WIDTH = 10
const SEP = '  ·  '

const WINDOWS = [
  { kind: 'five_hour', icon: '◷', label: '5h', title: '5-hour limit', seconds: 5 * 3600 },
  { kind: 'seven_day', icon: '◫', label: '7d', title: 'Weekly limit', seconds: 7 * 86400 },
] as const

/** One run of text in one style. */
type Run = { text: string; color?: Color; isBold?: boolean; isDim?: boolean }

/**
 * A segment of the bar: its runs, given the cells its bar may take (0 for
 * none); the figure whose change lights it; the details line hovering shows.
 */
type Segment = {
  id: string
  runs: (width: number) => Run[]
  hasBar: boolean
  unit?: 'context' | 'rateLimits' | 'cost'
  details: Run[]
}

/** The segments placed on one line, with where each one starts. */
type Line = { width: number; parts: { segment: Segment; runs: Run[]; column: number }[] }

/** What the person's settings show: each segment by its id, and the pace on limit bars. */
type Shown = Readonly<Record<'cost' | 'context' | 'five_hour' | 'seven_day' | 'updated' | 'pace', boolean>>

const ALL: Shown = { cost: true, context: true, five_hour: true, seven_day: true, updated: true, pace: true }

/** Reads the manifest's `show_*` options; an option left unset shows its segment. */
export function shownOf(options: Readonly<Record<string, unknown>>): Shown {
  const on = (key: string) => options[key] !== false

  return {
    cost: on('show_cost'),
    context: on('show_context'),
    five_hour: on('show_five_hour'),
    seven_day: on('show_weekly'),
    updated: on('show_last_change'),
    pace: on('show_pace'),
  }
}

/** Whether the person's theme is a light one; read at session start. */
let isLight = false

function tone(pct: number): string {
  return GRADIENT[Math.min(GRADIENT.length - 1, Math.floor((pct / 100) * GRADIENT.length))]
}

/** When a limit resets, in milliseconds, or undefined when it does not say. */
function resetOf(limit: Limit): number | undefined {
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN

  return Number.isNaN(at) ? undefined : at
}

/**
 * The bar's cells as runs: filled cells shaded along the gradient, then the
 * track, lighter up to the pace point (a fraction of the bar).
 */
function cells(pct: number, width: number, pace?: number): Run[] {
  if (width === 0) {
    return []
  }
  const filled = (pct / 100) * width
  const full = Math.floor(filled)
  const isHalf = filled - full >= 0.5 && full < width
  const paced = pace === undefined ? 0 : Math.round(pace * width)
  const runs: Run[] = []
  for (let i = 0; i < width; i++) {
    if (i < full) {
      runs.push({ text: '━', color: GRADIENT[Math.floor((i * GRADIENT.length) / width)] })
    } else if (i === full && isHalf) {
      runs.push({ text: '╸', color: GRADIENT[Math.floor((i * GRADIENT.length) / width)] })
    } else {
      runs.push({ text: '━', color: i < paced ? PACE : FAINT })
    }
  }
  runs.push({ text: ' ' })

  return runs
}

/** A labelled bar: its icon, an optional short label, the bar, and the percentage. */
function meter(icon: string, label: string | undefined, percent: number, pace?: number): (width: number) => Run[] {
  const pct = Math.max(0, Math.min(100, percent))
  const figure = `${Math.round(pct)}%`

  return width => [
    { text: label ? `${icon} ${label} ` : `${icon} `, color: LABEL },
    ...cells(pct, width, pace),
    { text: figure, color: tone(pct), isBold: true },
  ]
}

/** A length of time, as `3d 11h`, `2h 04m` or `45m`. */
function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)

  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A local clock time, led by the weekday when it is not today. */
function clock(ms: number, now: number, isSeconds = false): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  let text = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (isSeconds) {
    text += `:${pad(at.getSeconds())}`
  }

  return at.toDateString() === new Date(now).toDateString() ? text : `${DAYS[at.getDay()]} ${text}`
}

const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** A details line: the bold title, then muted labels with their values, joined. */
function details(title: string, ...rows: [label: string, value: string, color?: Color][]): Run[] {
  return [
    { text: title, isBold: true },
    ...rows.flatMap(([label, value, color]) => [
      { text: SEP, color: FAINT },
      { text: `${label} `, color: MUTED },
      { text: value, color, isBold: color !== undefined },
    ]),
  ]
}

function limitDetails(title: string, limit: Limit, pace: number | undefined, now: number): Run[] {
  const rows: [string, string, Color?][] = [['used', `${Math.round(limit.percentUsed)}%`, tone(limit.percentUsed)]]
  const at = resetOf(limit)
  if (at !== undefined) {
    rows.push(['resets', `${clock(at, now)}, in ${span(at - now)}`])
  }
  if (pace !== undefined) {
    const gone = Math.round(pace * 100)
    const ahead = limit.percentUsed - gone
    const verdict =
      ahead > 5 ? `${Math.round(ahead)} points ahead of pace` : ahead < -5 ? `${Math.round(-ahead)} points under pace` : 'on pace'
    rows.push(['window', `${gone}% gone, ${verdict}`])
  }

  return details(title, ...rows)
}

function segments(figures: Usage, now: number, shown: Shown): Segment[] {
  const list: Segment[] = []
  if (shown.cost && figures.costUsd !== undefined) {
    const text = `$${figures.costUsd.toFixed(2)}`
    const running: [string, string][] = figures.startedAt === undefined ? [] : [['running', span(now - figures.startedAt)]]
    list.push({
      id: 'cost',
      unit: 'cost',
      hasBar: false,
      runs: () => [
        { text: '◈ ', color: LABEL },
        { text, color: COST, isBold: true },
      ],
      details: details('Session cost', ['estimate', text, COST], ...running),
    })
  }
  if (shown.context && figures.contextPercent !== undefined) {
    const tokens: [string, string][] =
      figures.contextTokens === undefined || figures.contextWindow === undefined
        ? []
        : [['tokens', `${grouped(figures.contextTokens)} of ${grouped(figures.contextWindow)}`]]
    list.push({
      id: 'context',
      unit: 'context',
      hasBar: true,
      runs: meter('◰', 'c', figures.contextPercent),
      details: details('Context window', ['used', `${Math.round(figures.contextPercent)}%`, tone(figures.contextPercent)], ...tokens),
    })
  }
  for (const { kind, icon, label, title, seconds } of WINDOWS) {
    const limit = figures.limits.find(one => one.kind === kind)
    if (!shown[kind] || !limit) {
      continue
    }
    const at = resetOf(limit)
    // How far through its window the limit is, 0 to 1.
    const pace = at === undefined ? undefined : Math.max(0, Math.min(1, 1 - (at - now) / 1000 / seconds))
    const bar = meter(icon, label, limit.percentUsed, shown.pace ? pace : undefined)
    const countdown: Run[] =
      at === undefined
        ? []
        : [
            { text: ' ↻ ', color: MUTED, isDim: true },
            { text: span(at - now), color: MUTED },
          ]
    list.push({
      id: kind,
      unit: 'rateLimits',
      hasBar: true,
      runs: width => [...bar(width), ...countdown],
      details: limitDetails(title, limit, pace, now),
    })
  }
  if (shown.updated) {
    const since = now - figures.changedAt
    // Padded to its longest form so the bars don't resize as it ticks.
    const text = ago(since).padEnd(10)
    list.push({
      id: 'updated',
      hasBar: false,
      runs: () => [
        { text: '● ', color: since < 60_000 ? GRADIENT[0] : FAINT },
        { text, color: MUTED },
      ],
      details: details('Last change', ['at', clock(figures.changedAt, now, true)]),
    })
  }

  return list
}

function length(runs: Run[]): number {
  return runs.reduce((sum, run) => sum + [...run.text].length, 0)
}

/** The segments laid out on one line, their bars sharing what room is left. */
function place(figures: Usage, now: number, columns: number | undefined, shown: Shown): Line {
  const list = segments(figures, now, shown)
  const bars = list.filter(one => one.hasBar).length
  // Cells for each bar, in order: the room the rest leaves, shared out so the
  // line ends one column short of the edge however many bars there are.
  let widths = list.map(() => DEFAULT_WIDTH)
  if (columns !== undefined && bars > 0) {
    const fixed = list.reduce((sum, one) => sum + length(one.runs(0)), 0) + SEP.length * (list.length - 1)
    // Each bar also brings a space between it and its percentage.
    const room = columns - 1 - fixed - bars
    const base = Math.floor(room / bars)
    let extra = room - base * bars
    widths = list.map(() => (base >= MIN_WIDTH ? base + (extra-- > 0 ? 1 : 0) : 0))
  }
  let column = 0
  let bar = 0
  const parts = list.map((segment, i) => {
    if (i > 0) {
      column += SEP.length
    }
    const runs = segment.runs(segment.hasBar ? widths[bar++] : 0)
    const part = { segment, runs, column }
    column += length(runs)

    return part
  })
  // The last segment's padding would only push the line's end out.
  const last = parts.at(-1)?.runs
  if (last) {
    last[last.length - 1] = { ...last[last.length - 1], text: last[last.length - 1].text.trimEnd() }
  }

  return { width: column, parts }
}

/** The whole line as runs, for reading it as text (the tests do). */
export function layout(figures: Usage, now: number, columns: number | undefined, shown: Shown = ALL): Run[] {
  return place(figures, now, columns, shown).parts.flatMap((part, i) => (i > 0 ? [{ text: SEP, color: FAINT }, ...part.runs] : part.runs))
}

function figuresOf(e: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>) {
  return {
    costUsd: e.cost?.usd,
    contextPercent: e.context.percent,
    contextTokens: e.context.tokens,
    contextWindow: e.context.window,
    limits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
  }
}

export const register: Register = (on, options) => {
  const shown = shownOf(options)
  let isDrawn = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bar',
      description: 'Hide or show the usage bar',
    })
    const hidden = (await $.store.get(HIDDEN_KEY)) === true
    await update($, isHidden, () => hidden)
    try {
      isLight = String((await $.settings.read()).theme ?? '').includes('light')
    } catch {
      // Settings unreadable: keep the dark shades.
    }

    const current = await $.session.usage()
    const figures = figuresOf(current)
    if (figures.costUsd !== undefined || figures.contextPercent !== undefined || figures.limits.length > 0) {
      const now = await $.clock.now()
      await update($, usage, () => ({ ...figures, startedAt: current.startedAt, changedAt: now, changed: [] }))
    }

    // Keeps the countdowns, "ago" and the change highlight moving while
    // idle. Claude Code drops the timer when it reloads or ends the session.
    $.clock.every(1000, () => {
      if (isDrawn) {
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const figures = figuresOf(e)
    await update($, usage, previous => ({ ...figures, startedAt: previous?.startedAt, changedAt: now, changed: [...e.changed] }))

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    await $.store.set(HIDDEN_KEY, hidden)

    return { text: hidden ? 'Usage bar hidden. Run /usage-bar to show it again.' : 'Usage bar shown.' }
  })

  // The band's last row, under whatever else draws there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    isDrawn = false
    const figures = await read($, usage)
    if (figures === null || (await read($, isHidden))) {
      return next(e)
    }
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const line = place(figures, now, columns, shown)
    if (line.parts.length === 0) {
      return next(e)
    }
    const others = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    isDrawn = true
    const bar = draw(Box, Text, line, figures, now, columns)

    return others ? (
      <Box flexDirection="column">
        {others}
        {bar}
      </Box>
    ) : (
      bar
    )
  })
}

/** The hover group a segment and its details line share. */
const scopeOf = (segment: Segment) => `usage-bar-${segment.id}`

/**
 * The bar as a tree. Each segment lights a moment when its figure changes.
 * Hovering one reveals its details line over the whole row: inside the bar's
 * own row, so nothing clips it.
 */
function draw(Box: Elements['terminal']['Box'], Text: Elements['terminal']['Text'], line: Line, figures: Usage, now: number, columns: number | undefined) {
  const isFlashing = now - figures.changedAt < FLASH_MS
  const shades = isLight ? SHADES.light : SHADES.dark
  const width = Math.max(line.width, columns ?? 0)
  const text = (run: Run) => (
    <Text color={run.color} weight={run.isBold ? 'bold' : undefined} dimColor={run.isDim}>
      {run.text}
    </Text>
  )

  return (
    // The line's Box spans the whole room, so the details lines placed in it,
    // after the segments and so painted over them, span it too.
    <Box flexDirection="row" width={width}>
      {line.parts.map(({ segment, runs }, i) => {
        const isLit = isFlashing && segment.unit !== undefined && figures.changed.includes(segment.unit)

        return (
          <Box flexDirection="row">
            {i > 0 && <Text color={FAINT}>{SEP}</Text>}
            <Box
              key={segment.id}
              flexDirection="row"
              backgroundColor={isLit ? shades.flash : undefined}
              hover={{ scope: scopeOf(segment) }}
            >
              {runs.map(text)}
            </Box>
          </Box>
        )
      })}
      {line.parts.map(({ segment }) => (
        // Revealed while its segment is hovered (the two share a hover scope),
        // and kept while the pointer rests on it.
        <Box
          position="absolute"
          top={0}
          left={0}
          width={width}
          overflow="hidden"
          display="none"
          hover={{ scope: scopeOf(segment), display: 'flex' }}
          backgroundColor={shades.details}
        >
          <Text wrap="truncate-end">
            {segment.details.map(text)}
            {' '.repeat(Math.max(0, width - length(segment.details)))}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
