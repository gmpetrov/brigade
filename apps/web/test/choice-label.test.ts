import assert from 'node:assert/strict'
import { test } from 'node:test'
import { choiceLabel } from '../lib/choice-label'

test("the label's own number or letter goes in the badge, the rest is the name", () => {
  assert.deepEqual(choiceLabel('2 · Liste, bouton Pick à droite', 0), {
    mark: '2',
    name: 'Liste, bouton Pick à droite',
  })
  assert.deepEqual(choiceLabel('b · Calm', 1), { mark: 'B', name: 'Calm' })
  assert.deepEqual(choiceLabel('10. Last one', 5), { mark: '10', name: 'Last one' })
  assert.deepEqual(choiceLabel('3) Split', 2), { mark: '3', name: 'Split' })
})

test('a label without a mark gets its place in the list', () => {
  assert.deepEqual(choiceLabel('Une ligne, Riley', 0), { mark: '1', name: 'Une ligne, Riley' })
  assert.deepEqual(choiceLabel('Liste avec vignettes partout', 2), {
    mark: '3',
    name: 'Liste avec vignettes partout',
  })
})

test('words that only start like a mark stay whole', () => {
  // A word, not a mark: "A" followed by text without a separator.
  assert.deepEqual(choiceLabel('A bold landing', 0), { mark: '1', name: 'A bold landing' })
  assert.deepEqual(choiceLabel('2026 plan', 1), { mark: '2', name: '2026 plan' })
  // A mark with nothing after it is the whole label.
  assert.deepEqual(choiceLabel('1 ·', 0), { mark: '1', name: '1 ·' })
})
