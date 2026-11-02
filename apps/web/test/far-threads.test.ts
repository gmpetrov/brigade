import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batches, fetchFar, keepFar, latestOnly } from '../lib/far-threads'

// Threads waiting on the member, older than the latest the sidebar loads, asked for by id
// (lib/far-threads.ts): every one however many, and never an answer from before over a newer.

const ids = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

test('ids go in requests of at most 100', () => {
  assert.deepEqual(
    batches(ids(250)).map((b) => b.length),
    [100, 100, 50],
  )
  assert.deepEqual(batches([]), [])
})

test('more than 100 waiting: every one is asked for, a request per batch', async () => {
  const asked: string[][] = []
  const rows = await fetchFar(ids(101), async (path) => {
    const batch = new URLSearchParams(path.split('?')[1]).getAll('id')
    asked.push(batch)
    return batch.map((id) => ({ id }))
  })
  assert.deepEqual(
    asked.map((b) => b.length),
    [100, 1],
  )
  assert.equal(rows.length, 101)
  assert.deepEqual(rows.map((r) => r.id).sort(), ids(101).sort())
})

test('only those still waiting show: not archived, not loaded already, not asked for twice', () => {
  const rows = [
    { id: 'A', archivedAt: '2026-11-02T14:00:00.000Z' },
    { id: 'B' },
    { id: 'C' },
    { id: 'P', children: [{ id: 'child' }] },
    { id: 'B' },
    { id: 'gone' },
  ]
  // A was archived, C is loaded now, `gone` waits no more: an answer from before brought them.
  const kept = keepFar(rows, ['A', 'B', 'C', 'child'], new Set(['C']))
  assert.deepEqual(
    kept.map((t) => t.id),
    ['B', 'P'],
  )
})

test('an answer from before never replaces a newer one, whichever comes first', async () => {
  const got: string[][] = []
  const deliver = latestOnly<string[]>((v) => got.push(v))
  const pending = () => {
    let resolve!: (v: string[]) => void
    const promise = new Promise<string[]>((r) => (resolve = r))
    return { promise, resolve }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  // Asked for A, then A and B: the newer answers first, the older last.
  const old = pending()
  const newer = pending()
  deliver(old.promise)
  deliver(newer.promise)
  newer.resolve(['A', 'B'])
  await tick()
  old.resolve(['A'])
  await tick()
  assert.deepEqual(got, [['A', 'B']])

  // The older answers first: dropped, the newer lands.
  got.length = 0
  const first = pending()
  const second = pending()
  deliver(first.promise)
  deliver(second.promise)
  first.resolve(['A'])
  await tick()
  assert.deepEqual(got, [])
  second.resolve(['B'])
  await tick()
  assert.deepEqual(got, [['B']])

  // A failure leaves what was there.
  got.length = 0
  deliver(Promise.reject(new Error('offline')))
  await tick()
  assert.deepEqual(got, [])
})
