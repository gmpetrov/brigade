import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pebbleColor, pebbleOutline, pebbleStyle } from '../components/pebble-avatar'

const parts = (color: string) => {
  const [, l, c, h] = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/)!
  return [Number(l), Number(c), Number(h)] as const
}

test('a brand hue gives the og-image colour itself', () => {
  assert.equal(pebbleColor(90), 'oklch(0.871 0.140 90)') // yellow
  assert.equal(pebbleColor(290), 'oklch(0.621 0.220 290)') // purple
  assert.equal(pebbleColor(21), 'oklch(0.801 0.079 21)') // pink
})

test('between two brand colours, lightness and chroma go from one to the other', () => {
  const [l, c] = parts(pebbleColor(120)) // between yellow (90) and green (155)
  assert.ok(l < 0.871 && l > 0.781, String(l))
  assert.ok(c < 0.161 && c > 0.14, String(c))
})

test('every hue has a colour, across the wrap from purple back to pink', () => {
  for (let h = 0; h < 360; h++) {
    const [l, c, hue] = parts(pebbleColor(h))
    assert.equal(hue, h)
    assert.ok(l >= 0.621 && l <= 0.871, `${h}: ${l}`)
    assert.ok(c >= 0.079 && c <= 0.22, `${h}: ${c}`)
  }
  assert.equal(pebbleColor(360), pebbleColor(0))
})

test('a pebble is flat, with the brand ink for eyes, and the same for the same seed', () => {
  const style = pebbleStyle('teammate-1') as Record<string, string>
  assert.equal(style['--pebble-c1'], style['--pebble-c2'])
  assert.equal(style['--pebble-eye'], '#1b1230')
  assert.deepEqual(pebbleStyle('teammate-1'), style)
})

test('a shaped pebble morphs between three outlines of as many points, inside its box', () => {
  for (const [lobes, depth] of [
    [3, 0.17],
    [5, 0.08],
    [6, 0.12],
  ] as const) {
    const points = pebbleOutline(lobes, depth, 0.2, 1)
      .slice('polygon('.length, -1)
      .split(',')
      .map((p) => p.trim().split(' ').map(parseFloat))
    assert.equal(points.length, 48)
    for (const [x, y] of points) {
      assert.ok(x! >= 0 && x! <= 100 && y! >= 0 && y! <= 100, `${x} ${y}`)
    }
  }
})

test('about one seed in five gives a plain pebble, the others three morphing outlines', () => {
  let plain = 0
  for (let i = 0; i < 200; i++) {
    const style = pebbleStyle(`teammate-${i}`) as Record<string, string>
    if (!style['--pebble-p1']) {
      plain++
      continue
    }
    assert.ok(style['--pebble-p2'] && style['--pebble-p3'])
    assert.notEqual(style['--pebble-p1'], style['--pebble-p2'])
  }
  assert.ok(plain > 20 && plain < 70, String(plain))
})
