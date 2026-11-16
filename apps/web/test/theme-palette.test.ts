// A theme's colours on the dashboard's tokens (lib/theme-palette).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrast, inkOn, modeOf, parseHex, themeTokens } from '../lib/theme-palette'

test('a canvas says light or dark', () => {
  assert.equal(modeOf('#ffffff'), 'light')
  assert.equal(modeOf('#f4efe6'), 'light')
  assert.equal(modeOf('#0d1117'), 'dark')
  assert.equal(modeOf('#002b36'), 'dark')
})

test('text on an accent reads', () => {
  for (const accent of ['#ffcc00', '#1e40af', '#b4532a', '#22c55e', '#000000', '#ffffff'])
    assert.ok(contrast(parseHex(accent), parseHex(inkOn(accent))) >= 3, accent)
})

test('canvas and accent give the whole palette; single colours win', () => {
  const { mode, vars } = themeTokens({
    name: 'Paper',
    canvas: '#f4efe6',
    accent: '#b4532a',
    colors: { primary: '#123456' },
    radius: '0',
    font: '"Iowan Old Style", serif',
  })
  assert.equal(mode, 'light')
  assert.equal(vars.background, '#f4efe6')
  assert.equal(vars.primary, '#123456')
  assert.equal(vars.ring, '#b4532a')
  assert.match(vars.border!, /^color-mix\(in oklab, #f4efe6, #0b0b0d \d+(\.\d+)?%\)$/)
  assert.equal(vars.radius, '0')
  assert.equal(vars['font-sans'], '"Iowan Old Style", serif')
})

test('without a canvas the person keeps their light or dark look', () => {
  const { mode, vars } = themeTokens({ name: 'Accent', accent: '#22c55e' })
  assert.equal(mode, null)
  assert.equal(vars.background, undefined)
  assert.equal(vars.primary, '#22c55e')
})
