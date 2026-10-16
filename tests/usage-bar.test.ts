import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { layout, shownOf } from '../hooks/register.tsx'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const IN_2H = new Date(NOW + (2 * 3600 + 4 * 60 + 30) * 1000).toISOString()
const IN_3D = new Date(NOW + (3 * 86400 + 11 * 3600 + 30) * 1000).toISOString()

const FIGURES = {
  costUsd: 13.41,
  contextPercent: 58,
  limits: [
    { kind: 'five_hour', percentUsed: 71, resetsAt: IN_2H },
    { kind: 'seven_day', percentUsed: 46, resetsAt: IN_3D },
  ],
  changedAt: NOW - 42_000,
  changed: [] as ('context' | 'rateLimits' | 'cost')[],
}

const textOf = (runs: { text: string }[]) => runs.map(run => run.text).join('')

// A weekly limit 20% used with 51% of its window gone: a gap between the fill
// and the pace point, whatever the bar's width.
const BEHIND = { ...FIGURES, limits: [{ kind: 'seven_day', percentUsed: 20, resetsAt: IN_3D }] }

/** The colours of the 7d bar's cells. */
function trackOf(runs: { text: string; color?: string }[]): (string | undefined)[] {
  const start = runs.findIndex(run => run.text === '◫ 7d ')
  const end = runs.findIndex((run, i) => i > start && run.text === ' ')

  return runs.slice(start + 1, end).map(run => run.color)
}

// The band above the prompt, 120 columns wide.
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/** The engine beneath the plugin: a clock, a store, and answers for the events it raises. */
function world(on: On) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // What else draws in the band: another plugin's row.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return h(Box, null, h(Text, null, 'another row'))
  })

  return clock
}

async function measure($: Engine) {
  await $.session.measure({
    context: { window: 200_000, tokens: 116_000, percent: 58 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 71, resetsAt: IN_2H },
      { kind: 'seven_day', percentUsed: 46, resetsAt: IN_3D },
    ],
    cost: { usd: 13.41 },
    changed: ['context', 'rateLimits', 'cost'],
  })
}

describe('layout', () => {
  test('reads cost, context, both limits with countdowns, and the last change', () => {
    expect(textOf(layout(FIGURES, NOW, 120))).toBe(
      '◈ $13.41  ·  ◰ c ━━━━━━╸━━━━━ 58%  ·  ◷ 5h ━━━━━━━━╸━━━ 71% ↻ 2h 04m  ·  ◫ 7d ━━━━━━━━━━━ 46% ↻ 3d 11h  ·  ● 42s ago',
    )
  })

  test('stretches the bars to end one column short of the edge', () => {
    // "9m 05s ago" is as long as the last segment gets, so no padding is trimmed.
    for (const columns of [400, 200, 151, 150, 120, 100]) {
      expect([...textOf(layout({ ...FIGURES, changedAt: NOW - 545_000 }, NOW, columns))].length).toBe(columns - 1)
    }
  })

  test('drops the bars where even short ones would not fit', () => {
    const line = textOf(layout(FIGURES, NOW, 80))
    expect(line).toContain('◰ c 58%')
    expect([...line].length).toBeLessThanOrEqual(80)
  })

  test('keeps one space inside segments and two around each separator', () => {
    const low = { ...FIGURES, contextPercent: 3, limits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: IN_2H }] }
    for (const columns of [120, 80]) {
      const segments = textOf(layout(low, NOW, columns)).split('  ·  ')
      expect(segments.length).toBe(4)
      for (const segment of segments) {
        expect(segment.trimEnd()).not.toContain('  ')
      }
    }
  })

  test('leaves out what has no figure', () => {
    const line = textOf(layout({ costUsd: 2.5, limits: [], changedAt: NOW, changed: FIGURES.changed }, NOW, 120))
    expect(line).toBe('◈ $2.50  ·  ● just now')
  })

  test('lightens the empty track up to the pace point', () => {
    for (const columns of [120, 160, 240]) {
      const cells = trackOf(layout(BEHIND, NOW, columns))
      const fill = cells.filter(color => color !== 'inactive' && color !== 'subtle').length
      const pace = Math.round(0.506 * cells.length)
      // Filled cells, then lighter track up to the pace point, then the dark rest.
      expect(cells.slice(fill, pace).every(color => color === 'inactive')).toBe(true)
      expect(cells.slice(pace).every(color => color === 'subtle')).toBe(true)
      expect(pace - fill).toBeGreaterThan(0)
    }
  })
})

describe('settings', () => {
  test('show every metric by default', () => {
    expect(shownOf({})).toEqual({ cost: true, context: true, five_hour: true, seven_day: true, updated: true, pace: true })
  })

  test('leave out the metrics switched off, and give their room to the rest', () => {
    const shown = shownOf({ show_cost: false, show_weekly: false, show_last_change: false })
    const line = textOf(layout(FIGURES, NOW, 120, shown))
    expect(line).not.toContain('$13.41')
    expect(line).not.toContain('7d')
    expect(line).not.toContain('ago')
    expect([...line].length).toBe(119)
    // 119 columns, less the labels, figures and countdown, shared by two bars.
    expect(line).toMatch(/◰ c [━╸]{44} 58%  ·  ◷ 5h [━╸]{44} 71%/)
  })

  test('draw nothing of their own when every metric is off', { options: { show_cost: false, show_context: false, show_five_hour: false, show_weekly: false, show_last_change: false } }, async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toEqual(['another row'])
  })

  test('switch the pace off, leaving the whole empty track dark', () => {
    const cells = trackOf(layout(BEHIND, NOW, 120, shownOf({ show_pace: false })))
    expect(cells).not.toContain('inactive')
    expect(cells.at(-1)).toBe('subtle')
  })

  test('reach the drawn bar', { options: { show_cost: false } }, async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'cost' })).toBeUndefined()
    expect(await ui.find({ key: 'context' })).toBeDefined()
  })
})

describe('the bar above the prompt', () => {
  test('draws nothing before the first measurement', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /58%/ })).toBeUndefined()
  })

  test('draws the figures once measured, and counts up since the change', async ($, on) => {
    const clock = world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    for (const [key, text] of [['cost', '$13.41'], ['context', '58%'], ['five_hour', '2h 04m'], ['seven_day', '3d 11h'], ['updated', 'just now']]) {
      expect((await ui.find({ key }))?.text).toContain(text)
    }

    await clock.advance(42_000)
    const again = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await again.find({ type: 'Text', text: /42s ago/ })).toBeDefined()
  })

  test('/usage-bar hides it and shows it again', async ($, on) => {
    world(on)
    await measure($)
    const run = () =>
      $.command.run({ command: 'usage-bar', args: '', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 } } as never)

    expect(await run()).toMatchObject({ text: expect.stringContaining('hidden') })
    const hidden = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await hidden.find({ type: 'Text', text: /58%/ })).toBeUndefined()

    expect(await run()).toMatchObject({ text: 'Usage bar shown.' })
    const shown = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await shown.find({ type: 'Text', text: /58%/ })).toBeDefined()
  })

  test('lights the segments whose figures just changed, for two seconds', async ($, on) => {
    const clock = world(on)
    await $.session.measure({
      context: { window: 200_000, tokens: 116_000, percent: 58 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: IN_2H }],
      cost: { usd: 13.41 },
      changed: ['cost'],
    })
    const props = { plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND } as const
    const lit = async () => {
      const ui = await $.ui.mount(props)
      const keyed = async (key: string) => (await ui.drawn(), JSON.stringify(await ui.find({ key })))

      return { cost: await keyed('cost'), context: await keyed('context') }
    }

    const now = await lit()
    expect(now.cost).toContain('"backgroundColor":"#2c313c"')
    expect(now.context).not.toContain('"backgroundColor":"#2c313c"')

    await clock.advance(2500)
    expect((await lit()).cost).not.toContain('"backgroundColor":"#2c313c"')
  })

  test('holds a details line for each segment, shown on hover', async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /116,000 of 200,000/ })).toBeDefined()
    // Reset times read in the machine's own time zone.
    const at = new Date(Date.parse(IN_2H))
    const local = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    expect(await ui.find({ type: 'Text', text: new RegExp(`resets ${local}, in 2h 04m`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5-hour limit  ·  used 71%  ·  resets / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /window 59% gone, 12 points ahead of pace/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Last change/ })).toBeDefined()
  })

  test('stays under whatever else draws above the prompt', async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.indexOf('another row')).toBeLessThan(texts.indexOf('just now'))
  })

  test("fills the band's width", async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'context' }))?.text).toMatch(/◰ c [━╸]{12} 58%/)
  })

  test('spans the whole width with the details line, not just the bar', { options: { show_cost: false, show_context: false, show_weekly: false, show_last_change: false } }, async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    // A lone 5h bar's text ends short of the edge. The details line sits on
    // the full-width line, not inside its segment, so nothing narrower clips it.
    const tree = await ui.drawn()
    const lines: unknown[] = []
    const walk = (node: unknown, parentWidth?: unknown) => {
      if (!node || typeof node !== 'object') {
        return
      }
      const { props, children } = node as { props?: Record<string, unknown>; children?: unknown[] }
      if (props?.position === 'absolute') {
        lines.push({ width: props.width, parentWidth })
      }
      for (const child of children ?? (props?.children as unknown[]) ?? []) {
        walk(child, props?.width)
      }
    }
    walk(tree)
    // (The drawn tree a test reads leaves out hover styles, so the reveal
    // itself is the surface's to show.)
    expect(lines).toEqual([{ width: 120, parentWidth: 120 }])
  })

  test('draws on the desktop too', async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /58%/ })).toBeDefined()
  })
})
