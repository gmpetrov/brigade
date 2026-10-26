import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestSave } from '../lib/latest-save'

/** A save that waits until released, recording what it was given. */
function controlled() {
  const sent: string[] = []
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = []
  const save = (value: string) => {
    sent.push(value)
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  return { sent, pending, save, tick }
}

test('a save asked for while one runs waits for it, and only the latest is sent', async () => {
  const { sent, pending, save, tick } = controlled()
  const errors: unknown[] = []
  const ask = latestSave(save, (e) => errors.push(e))
  void ask('B,A,C')
  void ask('B,C,A')
  void ask('C,B,A')
  await tick()
  assert.deepEqual(sent, ['B,A,C'])
  pending[0]!.resolve()
  await tick()
  assert.deepEqual(sent, ['B,A,C', 'C,B,A'])
  pending[1]!.resolve()
  await tick()
  assert.deepEqual(errors, [])
  // Idle again: the next one goes at once.
  void ask('A,B,C')
  await tick()
  assert.deepEqual(sent, ['B,A,C', 'C,B,A', 'A,B,C'])
})

test('a failed save reports only when no newer one waits', async () => {
  const { pending, save, tick } = controlled()
  const errors: string[] = []
  const ask = latestSave(save, (e) => errors.push((e as Error).message))
  void ask('first')
  void ask('second')
  await tick()
  pending[0]!.reject(new Error('first failed'))
  await tick()
  assert.deepEqual(errors, [])
  pending[1]!.reject(new Error('second failed'))
  await tick()
  assert.deepEqual(errors, ['second failed'])
})
