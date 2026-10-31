import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultAccount, pickAccount } from '../lib/account-pick'

// Ada's default on the cloud computer was added first; Bob's own came later.
const adas = { id: 'ada', mine: false, isDefault: true }
const bobs = { id: 'bob', mine: true, isDefault: true }

test("a member's own default comes before a shared one added earlier", () => {
  assert.equal(defaultAccount([adas, bobs])?.id, 'bob')
})

test('their own account, even not default, before a shared one', () => {
  assert.equal(defaultAccount([adas, { ...bobs, isDefault: false }])?.id, 'bob')
})

test('without one of their own, the shared default', () => {
  assert.equal(defaultAccount([{ id: 'cat', mine: false, isDefault: false }, adas])?.id, 'ada')
})

test('a pick stays, while it is usable', () => {
  assert.equal(pickAccount([adas, bobs], 'ada')?.id, 'ada')
  assert.equal(pickAccount([adas, bobs], 'gone')?.id, 'bob')
})
