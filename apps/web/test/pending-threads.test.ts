import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SentMessage } from '../components/new-thread'
import type { ThreadSummary } from '../lib/api'
import {
  keptMessages,
  LISTED_WITHIN_MS,
  pendingRow,
  pendingThreads,
  unlistedThreads,
  withUnlisted,
  type PendingThread,
} from '../lib/pending-threads'

// A thread just sent shows in the sidebar at once (lib/pending-threads.ts): first in its list,
// until the list the API gives has it, and never twice; one that did not start leaves it at
// once, its message kept for the member.

const teammate = { id: 'riley', name: 'Riley' }
const sent = (over: Partial<Parameters<typeof pendingRow>[1]> = {}) => ({
  teammate,
  startedBy: { id: 'm1', name: 'Ada' },
  computer: { kind: 'cloud', name: 'Cloud' },
  projectId: null,
  text: 'Make the sidebar instant\nwith details',
  files: [],
  ...over,
})
const listed = (id: string) => pendingRow(id, sent({ text: `Listed ${id}` }))

let n = 0
/** A thread sent from a box: in the store, with its row. */
function send(giveBack: PendingThread['giveBack'] = 'dialog') {
  const id = `ctest${++n}`
  const message: SentMessage = {
    teammateId: teammate.id,
    text: 'Make the sidebar instant',
    uploads: [],
    effort: null,
  }
  pendingThreads.add(
    id,
    {
      teammate: teammate as PendingThread['teammate'],
      text: message.text,
      files: [],
      from: '/app',
      giveBack,
    },
    message,
    pendingRow(id, sent()),
  )
  return id
}
const ids = (list: ThreadSummary[] | undefined) => list?.map((t) => t.id)

test('its row is titled by its first line, a command and mentions as the API reads them', () => {
  assert.equal(pendingRow('c1', sent()).title, 'Make the sidebar instant')
  assert.equal(pendingRow('c1', sent({ text: '/visual a calmer card' })).title, 'a calmer card')
  assert.equal(
    pendingRow('c1', sent({ text: '', files: [{ name: 'brief.pdf' }, { name: 'logo.png' }] }))
      .title,
    'brief.pdf, logo.png',
  )
  assert.equal(pendingRow('c1', sent({ text: '  ' })).title, 'New thread')
  const row = pendingRow('c1', sent({ projectId: 'p1' }))
  assert.equal(row.status, 'starting')
  assert.equal(row.projectId, 'p1')
  assert.deepEqual(row.teammates, [{ teammate }])
})

test('sent, it is first in the list at once, and only once the list has it', () => {
  const id = send()
  const list = [listed('a'), listed('b')]
  assert.deepEqual(ids(withUnlisted(list, unlistedThreads())), [id, 'a', 'b'])
  // The list the API gives has it already (it told the dashboards as it made it): its own row.
  const withIt = [listed(id), ...list]
  assert.deepEqual(ids(withUnlisted(withIt, unlistedThreads())), [id, 'a', 'b'])
  pendingThreads.started(id)
  pendingThreads.listed(new Set(ids(withIt)))
  assert.equal(unlistedThreads().length, 0)
  // Nothing unlisted: the list itself, the same array (nothing renders again).
  assert.equal(withUnlisted(list, unlistedThreads()), list)
})

test('started, it stays until the list has it, so it never blinks out in between', () => {
  const id = send()
  pendingThreads.started(id)
  const at = unlistedThreads().find((u) => u.row.id === id)?.startedAt
  assert.ok(at)
  // A list loaded before it started: its row stays.
  pendingThreads.listed(new Set(['a']), at + 1000)
  assert.deepEqual(ids(withUnlisted([listed('a')], unlistedThreads())), [id, 'a'])
  // Still not listed long after it started: gone already (deleted at once), so is its row.
  pendingThreads.listed(new Set(['a']), at + LISTED_WITHIN_MS + 1)
  assert.equal(unlistedThreads().length, 0)
})

test('not started, it leaves the list at once and its message is kept for the member', () => {
  const id = send('dialog')
  assert.deepEqual(ids(withUnlisted([], unlistedThreads())), [id])
  pendingThreads.failed(id, 'That computer is offline. Start its runner and try again.')
  assert.equal(withUnlisted([listed('a')], unlistedThreads())?.length, 1)
  assert.equal(unlistedThreads().length, 0)
  // Nothing to ask the API for: it never started.
  assert.equal(pendingThreads.has(id), true)
  // Aside for the new-thread dialog, which offers it back.
  let back: { key: string; text: string; error?: string } | undefined
  const stop = keptMessages.handle((message) => (back = message))
  keptMessages.takeUp(id)
  stop()
  assert.equal(back?.key, id)
  assert.equal(back?.text, 'Make the sidebar instant')
  assert.match(back?.error ?? '', /offline/)
  keptMessages.drop(id)
})
