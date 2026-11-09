import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askingNow, keptAnswer, setAnswersScope } from '../lib/api'

test('an answer asked for before sign-out is not kept for whoever signs in next', () => {
  setAnswersScope('alice:w1')
  const keep = askingNow()
  // Alice signs out, Bob signs in before her request comes back.
  setAnswersScope(undefined)
  setAnswersScope('bob:w2')
  assert.equal(keep('/credentials', ['alice-secret']), false)
  assert.equal(keptAnswer('/credentials'), undefined)
})

test('an answer is kept for the person it was asked for', () => {
  setAnswersScope('carol:w3')
  const keep = askingNow()
  assert.equal(keep('/board', { cards: [] }), true)
  assert.deepEqual(keptAnswer('/board'), { cards: [] })
  setAnswersScope('carol:w4')
  assert.equal(keptAnswer('/board'), undefined)
})

test('nothing is kept while no one is signed in', () => {
  setAnswersScope(undefined)
  assert.equal(askingNow()('/board', 1), true)
  assert.equal(keptAnswer('/board'), undefined)
})

test('answers asked for as the dashboard opens are kept once its person is known', () => {
  setAnswersScope(undefined)
  const keep = askingNow()
  // /me comes back first and sets whose answers these are.
  setAnswersScope('dave:w5')
  assert.equal(keep('/accounts', ['dave-account']), true)
  assert.deepEqual(keptAnswer('/accounts'), ['dave-account'])
})
