import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Outgoing } from '../components/queued-messages'
import { expireAttempt, outgoingOf, updateOutgoing } from '../lib/outgoing-messages'

const message = (messageId: string): Outgoing => ({
  messageId,
  text: 'Hello',
  files: 0,
  uploads: [],
  afterSeq: 0,
  state: 'sending',
  queues: false,
  with: { attachmentIds: [] },
  draft: { text: 'Hello', elements: [], designEdits: [] },
})

// A thread's view goes when another thread opens (ThreadPanel keys it by thread): a message the
// API refuses after that must still be there, with its draft, when the thread opens again.
test('a message refused after its thread closed is still there, with its draft', () => {
  updateOutgoing('t1', (list) => [...list, message('m1')])
  // The thread's view is gone: the send answers, refused.
  updateOutgoing('t1', (list) =>
    list.map((o) => (o.messageId === 'm1' ? { ...o, state: 'unsent', error: 'Offline' } : o)),
  )
  const [kept] = outgoingOf('t1')
  assert.equal(kept?.state, 'unsent')
  assert.equal(kept?.error, 'Offline')
  assert.equal(kept?.draft?.text, 'Hello')
  // Another thread's are its own.
  assert.deepEqual(outgoingOf('t2'), [])
  // Discarded, it goes.
  updateOutgoing('t1', (list) => list.filter((o) => o.messageId !== 'm1'))
  assert.deepEqual(outgoingOf('t1'), [])
})

// Sent, the thread closed before the API answered, then the computer never confirmed: the
// deadline reads the store as it is then, not the view that sent it, which only saw it sending.
test('a message never confirmed fails after its thread closed and opened again', () => {
  updateOutgoing('t3', (list) => [...list, message('m3')])
  // The API takes it after the view went.
  updateOutgoing('t3', (list) => list.map((o) => ({ ...o, state: 'sent', sentAt: 1000 })))
  expireAttempt('t3', 'm3', 1000)
  assert.equal(outgoingOf('t3')[0]?.state, 'failed')
  // An attempt sent again since waits its own time.
  updateOutgoing('t3', (list) => list.map((o) => ({ ...o, state: 'sent', sentAt: 2000 })))
  expireAttempt('t3', 'm3', 1000)
  assert.equal(outgoingOf('t3')[0]?.state, 'sent')
  // One the thread showed is gone: its deadline changes nothing.
  updateOutgoing('t3', () => [])
  expireAttempt('t3', 'm3', 2000)
  assert.deepEqual(outgoingOf('t3'), [])
})
