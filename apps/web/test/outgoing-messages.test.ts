import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Outgoing } from '../components/queued-messages'
import { outgoingOf, updateOutgoing } from '../lib/outgoing-messages'

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
