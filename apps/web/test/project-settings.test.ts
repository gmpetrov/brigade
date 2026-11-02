import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fieldError,
  idle,
  preferAccount,
  saveFailed,
  saveMessage,
  saveStarted,
  saveSucceeded,
} from '../lib/project-settings'

test('two picks made before the first save returns both stay', () => {
  const loaded = ['stripe-a']
  // Each pick builds on the list the last one left, not on the project as loaded.
  const first = preferAccount(loaded, ['stripe-a', 'stripe-b'], 'stripe-b')
  const second = preferAccount(first, ['gmail-a', 'gmail-b'], 'gmail-b')
  assert.deepEqual(first, ['stripe-b'])
  assert.deepEqual(second, ['stripe-b', 'gmail-b'])
})

test('no preference takes only that App out', () => {
  assert.deepEqual(preferAccount(['stripe-b', 'gmail-b', 'neon'], ['gmail-a', 'gmail-b'], null), [
    'stripe-b',
    'neon',
  ])
})

test('a failed field keeps its error after another field saves', () => {
  let state = saveStarted(saveStarted(idle))
  state = saveFailed(state, ['name'], 'A project with that name already exists')
  state = saveSucceeded(state, ['brief'])
  assert.deepEqual(saveMessage(state), {
    error: true,
    text: 'A project with that name already exists',
  })
  // Once the name saves, the section says Saved.
  state = saveSucceeded(saveStarted(state), ['name'])
  assert.deepEqual(saveMessage(state), { error: false, text: 'Saved' })
})

test('Saving shows until every queued save is back', () => {
  let state = saveStarted(saveStarted(idle))
  state = saveSucceeded(state, ['brief'])
  assert.deepEqual(saveMessage(state), { error: false, text: 'Saving…' })
  state = saveSucceeded(state, ['url'])
  assert.deepEqual(saveMessage(state), { error: false, text: 'Saved' })
})

test('an error found before saving goes when cleared', () => {
  const state = fieldError(idle, 'logo', 'That image cannot be a logo')
  assert.equal(saveMessage(state)?.error, true)
  assert.equal(saveMessage(fieldError(state, 'logo', null)), null)
})
