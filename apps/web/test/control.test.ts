import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeControl, controlPending, shownThread } from '../lib/control'

const thread = (id: string, controlledByMemberId: string | null = null) => ({
  id,
  controlledByMemberId,
})
const controller = (t: ReturnType<typeof thread>) => shownThread(t).controlledByMemberId

/** A request the test answers or refuses itself. */
function deferred() {
  let answer!: () => void
  let refuse!: (e: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    answer = resolve
    refuse = reject
  })
  return { request: () => promise, answer, refuse }
}

test('taking control shows at once, while the API takes it', async () => {
  const before = thread('t1')
  const api = deferred()
  const going = changeControl('t1', 'ada', api.request)
  assert.equal(controller(before), 'ada')
  api.answer()
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
  const api = deferred()
  const first = changeControl('t4', 'ada', api.request)
  const second = changeControl('t4', null, async () => {})
  api.refuse(new Error('no'))
  await assert.rejects(first)
  await second
  assert.equal(controller(before), null)
})

test('the same object on each render, and the thread itself when it already agrees', async () => {
  const before = thread('t5')
  const api = deferred()
  const going = changeControl('t5', 'ada', api.request)
  assert.equal(shownThread(before), shownThread(before))
  const agrees = thread('t5', 'ada')
  assert.equal(shownThread(agrees), agrees)
  api.answer()
  await going
})

test('a hand back asked while its takeover still goes is sent after it', async () => {
  // As the API does: takeover writes its controller, then builds the spec before it sends.
  let specReady!: () => void
  const spec = new Promise<void>((r) => (specReady = r))
  const sent: string[] = []
  const taking = changeControl('t6', 'ada', async () => {
    await spec
    sent.push('takeover')
  })
  assert.equal(controlPending('t6'), true)
  const handing = changeControl('t6', null, async () => {
    sent.push('handback')
  })
  assert.equal(controller(thread('t6')), null)
  specReady()
  await Promise.all([taking, handing])
  assert.deepEqual(sent, ['takeover', 'handback'])
  assert.equal(controlPending('t6'), false)
})

test('a refused takeover does not stop the change asked after it', async () => {
  const sent: string[] = []
  const taking = changeControl('t7', 'ada', async () => {
    throw new Error('Another member has control of this thread')
  })
  const handing = changeControl('t7', null, async () => {
    sent.push('handback')
  })
  await assert.rejects(taking)
  await handing
  assert.deepEqual(sent, ['handback'])
})
