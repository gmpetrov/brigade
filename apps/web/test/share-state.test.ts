import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryShare } from '@brigade/contracts'
import { afterReply, ShareLinks, shownShare, turnLink, type ShareState } from '../lib/share-state'

// A bar's public link (lib/share-state.ts, components/share-button.tsx): replies come back late
// and out of order, and only those about the file shown now, and not answered by a newer one,
// count. Each request here waits until the test answers it, in the order a scenario needs.
const link = (token: string): LibraryShare => ({
  url: `https://www.brigade.lol/s/${token}`,
  createdAt: '',
  createdBy: null,
})

type Pending = {
  documentId: string
  method: string
  answer: (share: LibraryShare | null) => Promise<void>
  fail: () => Promise<void>
}

/** A bar whose requests wait in `asked` until answered. */
function bar() {
  const asked: Pending[] = []
  const links = new ShareLinks(
    (documentId, method) =>
      new Promise((resolve, reject) => {
        const settle = async (f: () => void) => {
          f()
          // Lets the bar take the reply in, and what it starts after.
          for (let i = 0; i < 5; i++) await Promise.resolve()
        }
        asked.push({
          documentId,
          method,
          answer: (share) => settle(() => resolve(share)),
          fail: () => settle(() => reject(new Error('Offline'))),
        })
      }),
  )
  /** The oldest request not answered yet, about `documentId` with `method`. */
  const take = (documentId: string, method: string) => {
    const at = asked.findIndex((r) => r.documentId === documentId && r.method === method)
    assert.ok(at >= 0, `no ${method} for ${documentId} waits: ${JSON.stringify(asked)}`)
    return asked.splice(at, 1)[0]!
  }
  return { links, asked, take }
}

test('a link turned on for one tab never shows on the tab opened meanwhile', async () => {
  const { links, take } = bar()
  links.show('A')
  await take('A', 'GET').answer(null)
  const turning = links.toggle('A', true)
  links.show('B')
  await take('B', 'GET').answer(null)
  await take('A', 'POST').answer(link('A'))
  await turning
  assert.equal(links.shareOf('B'), null)
  assert.equal(links.shareOf('A'), undefined)
})

test('a link turned off for one tab never shows the tab opened meanwhile as not shared', async () => {
  const { links, take } = bar()
  links.show('A')
  await take('A', 'GET').answer(link('A'))
  const turning = links.toggle('A', false)
  links.show('B')
  await take('B', 'GET').answer(link('B'))
  await take('A', 'DELETE').answer(null)
  await turning
  assert.deepEqual(links.shareOf('B'), link('B'))
})

test('a read that comes back while a change is under way never undoes it', async () => {
  const { links, take } = bar()
  links.show('A')
  await take('A', 'GET').answer(null)
  const turning = links.toggle('A', true)
  // The library changed meanwhile (another file): read again, before the link is made.
  links.refresh()
  await take('A', 'GET').answer(null)
  await take('A', 'POST').answer(link('A'))
  assert.deepEqual(await turning, link('A'))
  assert.deepEqual(links.shareOf('A'), link('A'))
  // Read again once it landed, which says the same.
  await take('A', 'GET').answer(link('A'))
  assert.deepEqual(links.shareOf('A'), link('A'))
})

test('a read that started before a change and comes back after it never undoes it', async () => {
  const { links, take } = bar()
  links.show('A')
  await take('A', 'GET').answer(null)
  links.refresh()
  const before = take('A', 'GET')
  const turning = links.toggle('A', true)
  await take('A', 'POST').answer(link('A'))
  await turning
  await before.answer(null)
  assert.deepEqual(links.shareOf('A'), link('A'))
})

test('after a change that failed, the link is read again', async () => {
  const { links, take } = bar()
  links.show('A')
  await take('A', 'GET').answer(null)
  const turning = links.toggle('A', true)
  await take('A', 'POST').fail()
  await assert.rejects(turning, /Offline/)
  // Another member had turned it on meanwhile.
  await take('A', 'GET').answer(link('other'))
  assert.deepEqual(links.shareOf('A'), link('other'))
})

test('another member turning a link off shows once the library says it changed', async () => {
  const { links, take } = bar()
  links.show('A')
  await take('A', 'GET').answer(link('A'))
  links.refresh()
  await take('A', 'GET').answer(null)
  assert.equal(links.shareOf('A'), null)
})

test('the switch always makes the change, whoever wants to know', async () => {
  const made: boolean[] = []
  const toggle = async (on: boolean) => (made.push(on), on ? link('A') : null)
  assert.deepEqual(await turnLink(toggle, true), link('A'))
  let told: boolean | undefined
  await turnLink(toggle, false, (shared) => (told = shared))
  assert.deepEqual(made, [true, false])
  assert.equal(told, false)
})

test('replies about another file, or older than the one applied, change nothing', () => {
  let state: ShareState = afterReply(null, 'A', { documentId: 'A', share: link('A'), seq: 2 })
  state = afterReply(state, 'A', { documentId: 'A', share: null, seq: 1 })
  assert.deepEqual(shownShare(state, 'A'), link('A'))
  state = afterReply(state, 'A', { documentId: 'B', share: null, seq: 3 })
  assert.deepEqual(shownShare(state, 'A'), link('A'))
  assert.equal(shownShare(state, 'B'), undefined)
  assert.equal(shownShare(state, null), undefined)
})
