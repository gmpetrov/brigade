import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startProviderSignIn, takeProviderSignIn } from '../src/provider-sign-in.js'

test('a sign-in this app started comes back once', () => {
  const nonce = startProviderSignIn()
  assert.ok(nonce.length >= 32)
  assert.equal(takeProviderSignIn('forged'), false)
  assert.equal(takeProviderSignIn(nonce), true)
  assert.equal(takeProviderSignIn(nonce), false)
})

test('and within half an hour', () => {
  const nonce = startProviderSignIn(0)
  assert.equal(takeProviderSignIn(nonce, 31 * 60_000), false)
})
