import assert from 'node:assert/strict'
import { test } from 'node:test'
import { afterReply, shownShare, type ShareState } from '../lib/share-state'

// A bar's public link (lib/share-state.ts, components/share-button.tsx): replies come back late
// and out of order, and only those about the file shown now, newer than the one applied, count.
const link = (token: string) => ({
  url: `https://www.brigade.lol/s/${token}`,
  createdAt: '',
  createdBy: null,
})

test('a link turned on for one tab never shows on the tab opened meanwhile', () => {
  // A is shown; its GET says no link; its POST starts (3) and the person switches to B.
  let state: ShareState = afterReply(null, 'A', { documentId: 'A', share: null, seq: 1 })
  // B's GET (4) comes back first: B has none.
  state = afterReply(state, 'B', { documentId: 'B', share: null, seq: 4 })
  // Then A's POST: about A, which is no longer shown.
  state = afterReply(state, 'B', { documentId: 'A', share: link('A'), seq: 3 })
  assert.equal(shownShare(state, 'B'), null)
  assert.equal(shownShare(state, 'A'), undefined)
})

test('a link turned off for one tab never shows the tab opened meanwhile as not shared', () => {
  let state: ShareState = afterReply(null, 'B', { documentId: 'B', share: link('B'), seq: 5 })
  state = afterReply(state, 'B', { documentId: 'A', share: null, seq: 4 })
  assert.deepEqual(shownShare(state, 'B'), link('B'))
})

test('an older reply about the shown file never undoes a newer one', () => {
  // The GET (1) started before the POST (2), and comes back after it.
  let state: ShareState = afterReply(null, 'A', { documentId: 'A', share: link('A'), seq: 2 })
  state = afterReply(state, 'A', { documentId: 'A', share: null, seq: 1 })
  assert.deepEqual(shownShare(state, 'A'), link('A'))
  // A newer one does: another member turned it off.
  state = afterReply(state, 'A', { documentId: 'A', share: null, seq: 3 })
  assert.equal(shownShare(state, 'A'), null)
})

test('nothing shows for a file until a reply about it came back', () => {
  const state: ShareState = afterReply(null, 'A', { documentId: 'A', share: link('A'), seq: 1 })
  assert.equal(shownShare(state, 'B'), undefined)
  assert.equal(shownShare(state, null), undefined)
  // Back on A, before its new GET: what was known of A.
  assert.deepEqual(shownShare(state, 'A'), link('A'))
})
