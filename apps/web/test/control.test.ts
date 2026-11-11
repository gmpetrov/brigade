import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeControl, shownThread } from '../lib/control'

const thread = (id: string, controlledByMemberId: string | null = null) => ({
  id,
  controlledByMemberId,
})
const controller = (t: ReturnType<typeof thread>) => shownThread(t).controlledByMemberId

test('taking control shows at once, while the API takes it', async () => {
  const before = thread('t1')
  let answer!: () => void
  const going = changeControl('t1', 'ada', () => new Promise<void>((r) => (answer = r)))
  assert.equal(controller(before), 'ada')
  answer()
  await going
  // The thread fetched before it was through still shows the change.
  assert.equal(controller(before), 'ada')
})

test('once through, a thread fetched since wins', async () => {
  const before = thread('t2')
  await changeControl('t2', 'ada', async () => {
    assert.equal(controller(before), 'ada')
  })
  // Another member took it since.
  assert.equal(controller(thread('t2', 'bob')), 'bob')
  assert.equal(controller(before), 'ada')
})

test('refused, every view goes back', async () => {
  const before = thread('t3', 'ada')
  await assert.rejects(
    changeControl('t3', null, async () => {
      assert.equal(controller(before), null)
      throw new Error('You do not have control of this thread')
    }),
    /do not have control/,
  )
  assert.equal(controller(before), 'ada')
})

test('a later change is not undone by an earlier one refused', async () => {
  const before = thread('t4')
  let refuse!: (e: Error) => void
  const first = changeControl('t4', 'ada', () => new Promise((_, r) => (refuse = r)))
  const second = changeControl('t4', null, async () => {})
  refuse(new Error('no'))
  await assert.rejects(first)
  await second
  assert.equal(controller(before), null)
})

test('the same object on each render, and the thread itself when it already agrees', async () => {
  const before = thread('t5')
  let answer!: () => void
  const going = changeControl('t5', 'ada', () => new Promise<void>((r) => (answer = r)))
  assert.equal(shownThread(before), shownThread(before))
  const agrees = thread('t5', 'ada')
  assert.equal(shownThread(agrees), agrees)
  answer()
  await going
})
