import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Outgoing } from '../components/queued-messages'
import type { Item, QueuedMessage } from '../components/thread-view'
import {
  ASIDE_GRACE_MS,
  asidesOnTheirWay,
  expireAttempt,
  outgoingOf,
  updateOutgoing,
} from '../lib/outgoing-messages'

const message = (messageId: string): Outgoing => ({
  messageId,
  text: 'Hello',
  files: 0,
  uploads: [],
  afterSeq: 0,
  at: 0,
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

// Sent during its teammate's turn, it shows in the turn's Aside at once (no "Sending…" card),
// until the thread shows its side reply, or it waits in the queue when none comes.
test('a message sent during a turn shows in its Aside until its side reply shows', () => {
  const sent: Outgoing = { ...message('m4'), state: 'sent', queues: true, aside: true, at: 0 }
  const queuedOne = { messageId: 'm4' } as QueuedMessage
  const side = (status: 'answering' | 'answered' | 'failed', id = 'm4') =>
    ({ kind: 'user', side: { messageId: id, status } }) as Item
  const ids = (list: Outgoing[]) => list.map((o) => o.messageId)
  // On its way: the thread has nothing of it yet.
  assert.deepEqual(ids(asidesOnTheirWay([sent], [], [], new Set(), 0)), ['m4'])
  // Queued a moment ago, its side reply not begun: still in the Aside, not in the queue.
  assert.deepEqual(ids(asidesOnTheirWay([sent], [], [queuedOne], new Set(['m4']), 1000)), ['m4'])
  // Its side reply shows: the thread's own takes its place.
  assert.deepEqual(asidesOnTheirWay([sent], [side('answering')], [], new Set(['m4']), 1000), [])
  // Queued past the grace with no side reply: it waits in the queue, as any message.
  assert.deepEqual(
    asidesOnTheirWay([sent], [], [queuedOne], new Set(['m4']), ASIDE_GRACE_MS + 1),
    [],
  )
  // Unless an earlier aside is still being answered: each waits for those before it.
  assert.deepEqual(
    ids(
      asidesOnTheirWay(
        [sent],
        [side('answering', 'm0')],
        [queuedOne],
        new Set(['m4']),
        ASIDE_GRACE_MS + 1,
      ),
    ),
    ['m4'],
  )
  // Not through: it shows in the queue, with Retry and Edit.
  assert.deepEqual(asidesOnTheirWay([{ ...sent, state: 'unsent' }], [], [], new Set(), 0), [])
  // Sent while the teammate was idle: a bubble in the thread, not an aside.
  assert.deepEqual(asidesOnTheirWay([{ ...sent, aside: false }], [], [], new Set(), 0), [])
})
