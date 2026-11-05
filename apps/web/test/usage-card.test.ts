import assert from 'node:assert/strict'
import { test } from 'node:test'

// The card's grid is laid out in the person's own hours: Paris, across the end of summer time.
process.env.TZ = 'Europe/Paris'
const { cardGrid, cardText, rise, shades } = await import('../lib/usage-card')

const totals = (n: number) => ({ input: n, cacheRead: 0, cacheWrite: 0, output: 0, runs: 1 })

test('24 hours: a column per hour, a row per quarter, ending with the current hour', () => {
  const now = new Date('2026-11-04T15:40:00Z') // 16:40 in Paris
  const grid = cardGrid(
    1,
    [
      { at: '2026-11-04T15:30:00Z', tokens: 5 }, // 16:30, the last column's third quarter
      { at: '2026-11-03T16:00:00Z', tokens: 7 }, // 17:00 yesterday, the first column
      { at: '2026-11-03T15:45:00Z', tokens: 9 }, // before the grid
    ],
    now,
  )
  assert.equal(grid.columns, 24)
  assert.equal(grid.rows, 4)
  assert.equal(grid.cells[2 * 24 + 23], 5)
  assert.equal(grid.cells[0], 7)
  assert.equal(
    grid.cells.reduce((a, b) => a + b),
    12,
  )
})

test('7 days: a row per 24 hours up to now, a column per hour', () => {
  const now = new Date('2026-11-04T10:00:00Z') // 11:00 in Paris: the grid ends at noon
  const grid = cardGrid(
    7,
    [
      { at: '2026-11-04T09:15:00Z', tokens: 3 }, // today 10:15: the last row, its 23rd hour
      { at: '2026-11-04T09:45:00Z', tokens: 4 }, // the same hour
      { at: '2026-10-28T23:30:00Z', tokens: 2 }, // 29 Oct 00:30: the first row, 13th hour
      { at: '2026-10-28T10:30:00Z', tokens: 8 }, // before the grid
    ],
    now,
  )
  assert.equal(grid.cells[6 * 24 + 22], 7)
  assert.equal(grid.cells[12], 2)
  assert.equal(
    grid.cells.reduce((a, b) => a + b),
    9,
  )
})

test('30 days: a column per 24 hours up to now, a row per 3 hours', () => {
  const now = new Date('2026-11-04T10:00:00Z') // 11:00 in Paris: the grid ends at noon
  const grid = cardGrid(
    30,
    [
      { at: '2026-10-06T06:00:00Z', tokens: 1 }, // first column, 7th row
      { at: '2026-10-26T21:00:00Z', tokens: 6 }, // after the clocks went back: column 22, row 4
      { at: '2026-11-04T09:00:00Z', tokens: 2 }, // the last cell
      { at: '2026-10-05T10:00:00Z', tokens: 9 }, // before the grid
    ],
    now,
  )
  assert.equal(grid.columns, 30)
  assert.equal(grid.rows, 8)
  assert.equal(grid.cells[6 * 30 + 0], 1)
  assert.equal(grid.cells[3 * 30 + 21], 6)
  assert.equal(grid.cells[7 * 30 + 29], 2)
  assert.equal(
    grid.cells.reduce((a, b) => a + b),
    9,
  )
})

test('shades go by rank among the cells that spent, from 1 to 4, and 0 for none', () => {
  assert.deepEqual(shades([0, 1, 2, 3, 4, 5, 6, 7, 8]), [0, 1, 1, 2, 2, 3, 3, 4, 4])
  assert.deepEqual(shades([0, 0]), [0, 0])
  assert.deepEqual(shades([0, 1_000_000_000]), [0, 4])
  assert.deepEqual(shades([5, 5, 5]), [4, 4, 4])
})

test('the rise shows only when usage went up from a period that spent something', () => {
  assert.equal(rise(totals(138), totals(100)), 38)
  assert.equal(rise(totals(80), totals(100)), null)
  assert.equal(rise(totals(100), totals(100)), null)
  assert.equal(rise(totals(100), totals(0)), null)
  assert.equal(rise(totals(100), null), null)
})

test('the card says the period and its total', () => {
  const text = cardText({
    days: 7,
    totals: totals(48_200_000),
    previous: null,
  } as Parameters<typeof cardText>[0])
  assert.equal(text.total, '48.2M tokens')
  assert.equal(text.title, 'Last 7 days')
})

test('the hour the clocks go back through twice keeps its tokens, the second time too', () => {
  // 25 Oct 2026, 02:30 in Paris the second time (winter time, 01:30 UTC).
  const now = new Date('2026-10-25T01:40:00Z')
  const grid = cardGrid(1, [{ at: '2026-10-25T01:30:00Z', tokens: 10 }], now)
  assert.equal(grid.cells[2 * 24 + 23], 10)
})
