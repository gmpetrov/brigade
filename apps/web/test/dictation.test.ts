import assert from 'node:assert/strict'
import { test } from 'node:test'
import { levelOf, withDictated } from '../components/dictation'

test('the words heard go after what is in the box, a space between', () => {
  assert.equal(withDictated('', 'Bonjour'), 'Bonjour')
  assert.equal(withDictated('  ', 'Bonjour'), 'Bonjour')
  assert.equal(withDictated('Regarde ça', 'puis réponds'), 'Regarde ça puis réponds')
  assert.equal(withDictated('Première ligne\n', 'Deuxième'), 'Première ligne\nDeuxième')
})

test('silence draws a dot, speech a bar, never past full', () => {
  assert.equal(levelOf(new Float32Array(512)), 0)
  // Room noise stays below what counts as heard (HEARD, 0.12).
  assert.ok(levelOf(new Float32Array(512).fill(0.002)) < 0.12)
  // Speech, around -20 dBFS, fills about half the bar.
  const speech = levelOf(new Float32Array(512).fill(0.1))
  assert.ok(speech > 0.4 && speech < 0.7, String(speech))
  assert.equal(levelOf(new Float32Array(512).fill(1)), 1)
})
