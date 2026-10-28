import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestJump } from '../lib/latest-jump'

/** A thread's page loads, each one resolved by hand: one at a time, as in useThreadEvents. */
function pages() {
  let loading = false
  const asked: number[] = []
  const pending: ((went: boolean) => void)[] = []
  const go = (seq: number) => {
    asked.push(seq)
    loading = true
    return new Promise<boolean>((resolve) =>
      pending.push((went) => {
        loading = false
        resolve(went)
      }),
    )
  }
  return { busy: () => loading, go, asked, pending }
}
const tick = () => new Promise((r) => setImmediate(r))

test('a message clicked while another one loads goes once that one is in', async () => {
  const p = pages()
  const jumps = latestJump(p.busy, p.go)
  const first = jumps.want(100)
  const second = jumps.want(4000)
  assert.deepEqual(p.asked, [100])
  p.pending.shift()!(true)
  await tick()
  assert.deepEqual(p.asked, [100, 4000])
  p.pending.shift()!(true)
  await Promise.all([first, second])
})

test('only the latest of several clicks goes', async () => {
  const p = pages()
  const jumps = latestJump(p.busy, p.go)
  void jumps.want(100)
  void jumps.want(3000)
  void jumps.want(4000)
  p.pending.shift()!(true)
  await tick()
  assert.deepEqual(p.asked, [100, 4000])
})

test('a click during another page load (older messages, a gap) goes when it ends', async () => {
  let loading = true
  const asked: number[] = []
  const jumps = latestJump(
    () => loading,
    async (seq) => {
      asked.push(seq)
      return true
    },
  )
  void jumps.want(100)
  assert.deepEqual(asked, [])
  loading = false
  await jumps.next()
  assert.deepEqual(asked, [100])
})

test('a page that changed under it tries again, a few times at most', async () => {
  const asked: number[] = []
  const jumps = latestJump(
    () => false,
    async (seq) => {
      asked.push(seq)
      return false
    },
  )
  await jumps.want(100)
  assert.deepEqual(asked, [100, 100, 100])
})

test('another thread: nothing waits any more', async () => {
  const p = pages()
  const jumps = latestJump(p.busy, p.go)
  void jumps.want(100)
  void jumps.want(4000)
  jumps.clear()
  p.pending.shift()!(true)
  await tick()
  assert.deepEqual(p.asked, [100])
})

test('a failed load given way to a newer click: the newer one goes, and that failure is not said', async () => {
  const asked: number[] = []
  const pending: { resolve: (went: boolean) => void; reject: (e: Error) => void }[] = []
  let loading = false
  const jumps = latestJump(
    () => loading,
    (seq) => {
      asked.push(seq)
      loading = true
      return new Promise<boolean>((resolve, reject) =>
        pending.push({
          resolve: (went) => ((loading = false), resolve(went)),
          reject: (e) => ((loading = false), reject(e)),
        }),
      )
    },
  )
  const first = jumps.want(100)
  const second = jumps.want(4000)
  // The first gave way: it settles without an error.
  await first
  pending.shift()!.reject(new Error('offline'))
  await tick()
  assert.deepEqual(asked, [100, 4000])
  pending.shift()!.reject(new Error('offline again'))
  // The newer one hears of its own failure.
  await assert.rejects(second, /offline again/)
})

test('a failed load nothing newer waits on: its click hears of it', async () => {
  const jumps = latestJump(
    () => false,
    async () => {
      throw new Error('offline')
    },
  )
  await assert.rejects(jumps.want(100), /offline/)
  // And nothing waits after it.
  await jumps.next()
})
