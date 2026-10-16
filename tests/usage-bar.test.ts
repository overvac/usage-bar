import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { layout } from '../hooks/register.tsx'

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
}

const textOf = (runs: { text: string }[]) => runs.map(run => run.text).join('')

const band = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

/** The engine beneath the plugin: a clock, a store, and answers for the events it raises. */
function world(on: On) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // The engine's own band: an empty box when it has nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, null)
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
      '$13.41  ·  ◔ ctx ━━━━━━━━━━━ 58%  ·  ◷ 5h ━━━━━━━╸━━━ 71% ↻ 2h 04m  ·  ◫ 7d ━━━━━━━━━━━ 46% ↻ 3d 11h  ·  ● 42s ago',
    )
  })

  test('stretches the bars to fill the width, within 4 to 30 cells', () => {
    for (const columns of [200, 150, 120, 100]) {
      const line = textOf(layout(FIGURES, NOW, columns))
      expect([...line].length).toBeLessThanOrEqual(columns)
    }
    expect(textOf(layout(FIGURES, NOW, 400))).toContain('◔ ctx ' + '━'.repeat(30) + ' 58%')
  })

  test('drops the bars where even short ones would not fit', () => {
    const line = textOf(layout(FIGURES, NOW, 80))
    expect(line).toContain('◔ ctx 58%')
    expect([...line].length).toBeLessThanOrEqual(80)
  })

  test('leaves out what has no figure', () => {
    const line = textOf(layout({ costUsd: 2.5, limits: [], changedAt: NOW }, NOW, 120))
    expect(line).toBe('$2.50  ·  ● just now')
  })
})

describe('the band above the prompt', () => {
  test('draws nothing before the first measurement', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: band(120) })
    expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  })

  test('draws the figures once measured, and counts up since the change', async ($, on) => {
    const clock = world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: band(120) })
    expect(await ui.find({ type: 'Text', text: /\$13\.41.*58%.*71% ↻ 2h 04m.*46% ↻ 3d 11h.*just now/ })).toBeDefined()

    await clock.advance(42_000)
    const again = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: band(120) })
    expect(await again.find({ type: 'Text', text: /42s ago/ })).toBeDefined()
  })

  test('/usage-bar hides it and shows it again', async ($, on) => {
    world(on)
    await measure($)
    const run = () =>
      $.command.run({ command: 'usage-bar', args: '', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 } } as never)

    expect(await run()).toMatchObject({ text: expect.stringContaining('hidden') })
    const hidden = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: band(120) })
    expect(await hidden.find({ type: 'Text', text: /ctx/ })).toBeUndefined()

    expect(await run()).toMatchObject({ text: 'Usage bar shown.' })
    const shown = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: band(120) })
    expect(await shown.find({ type: 'Text', text: /ctx/ })).toBeDefined()
  })

  test('draws on the desktop too', async ($, on) => {
    world(on)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: band(120) })
    expect(await ui.find({ type: 'Text', text: /58%/ })).toBeDefined()
  })
})
