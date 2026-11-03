import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Account, AccountLogin } from '../lib/api'
import { caughtUp, shownLogin, underWay } from '../lib/thread-sign-in'

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
