import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Account, AccountLogin } from '../lib/api'
import {
  catchUpAfterReconnect,
  caughtUp,
  shownLogin,
  signInCards,
  underWay,
} from '../lib/thread-sign-in'

const account = (over: Partial<Account> = {}) =>
  ({
    id: 'a',
    provider: 'claude_code',
    source: 'brigade',
    mine: true,
    status: 'signing_in',
    login: null,
    computer: { id: 'c', name: 'Cloud', kind: 'cloud' },
    ...over,
  }) as Account
const prompt: AccountLogin = { state: 'open_url', flow: 'paste', url: 'https://claude.ai/login' }

test('a sign-in started on Accounts after the card opened shows its steps from the socket', () => {
  const login = shownLogin(prompt, account({ status: 'ready' }))
  assert.equal(login, prompt)
  assert.ok(underWay(login))
})

test('a sign-in already under way when the card opens shows from the list', () => {
  assert.equal(shownLogin(null, account({ login: prompt })), prompt)
})

test("another member's sign-in never shows", () => {
  assert.equal(shownLogin(null, account({ mine: false, login: prompt })), null)
})

test('after a reconnect, a prompt missed meanwhile shows as the list has it', () => {
  assert.deepEqual(caughtUp(account({ login: prompt }), true), { live: prompt })
})

test('after a reconnect, a followed sign-in that ended with the account ready is done', () => {
  assert.deepEqual(caughtUp(account({ status: 'ready' }), true), { live: null, done: true })
})

test('after a reconnect, a followed sign-in that ended without it is interrupted', () => {
  assert.deepEqual(caughtUp(account({ status: 'signing_in' }), true), {
    live: null,
    interrupted: true,
  })
})

test('after a reconnect, nothing changes for a sign-in the card never followed', () => {
  assert.equal(caughtUp(account({ status: 'ready' }), false), null)
  assert.equal(caughtUp(account({ mine: false, login: prompt }), true), null)
})

test('a prompt heard while the catch-up loads is not replaced by the older list', async () => {
  let heard = 0
  let resolve!: (list: Account[]) => void
  const pending = catchUpAfterReconnect(
    () => new Promise<Account[]>((r) => (resolve = r)),
    'a',
    () => true,
    () => heard,
  )
  // The socket says open_url, then the list taken before it answers with starting.
  heard++
  resolve([account({ login: { state: 'starting' } })])
  assert.equal(await pending, null)
})

test('with nothing heard meanwhile, the catch-up applies', async () => {
  const next = await catchUpAfterReconnect(
    async () => [account({ login: prompt })],
    'a',
    () => true,
    () => 0,
  )
  assert.deepEqual(next, { live: prompt })
})

test('a turn tried again and failed again signs in once, from its latest error', () => {
  const at = signInCards([
    { kind: 'user', key: 'u1' },
    { kind: 'error', key: 'e2', signedOutAccountId: 'a' },
    { kind: 'error', key: 'e5', signedOutAccountId: 'a' },
    { kind: 'error', key: 'e7', signedOutAccountId: 'b' },
    { kind: 'error', key: 'e8' },
  ])
  assert.equal(at.get('a'), 'e5')
  assert.equal(at.get('b'), 'e7')
  assert.equal(at.size, 2)
})
