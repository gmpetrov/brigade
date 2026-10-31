import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCORE, searchText, titleScore } from '../dist/index.js'

test('searchText: lower case, no accents, punctuation as spaces', () => {
  assert.equal(searchText('Launch-Checklist.md'), 'launch checklist md')
  assert.equal(searchText('  Créer  la   doc '), 'creer la doc')
})

test("a file's name is its last part without its extension", () => {
  const path = 'Projects/Brigade/launch-checklist.md'
  assert.equal(titleScore('launch checklist', path, 'file'), SCORE.exact)
  assert.equal(titleScore('launch-checklist', path, 'file'), SCORE.exact)
  assert.equal(titleScore('launch check', path, 'file'), SCORE.prefix)
  assert.equal(titleScore('brigade launch', path, 'file'), SCORE.words)
  // Not a file: its whole title.
  assert.equal(titleScore('launch checklist', path), SCORE.words)
})

test('tiers, from the name as typed to a typo', () => {
  assert.equal(titleScore('Pricing', 'pricing'), SCORE.exact)
  assert.equal(titleScore('docs pub', 'Docs publiques du lancement'), SCORE.prefix)
  assert.equal(titleScore('lancement docs', 'Docs publiques du lancement'), SCORE.words)
  assert.equal(titleScore('ancement', 'Docs publiques du lancement'), SCORE.inside)
  assert.equal(titleScore('cecklist', 'Launch checklist'), SCORE.near)
  assert.equal(titleScore('creer', 'Créer la documentation'), SCORE.prefix)
  assert.equal(titleScore('  ', 'anything'), 0)
})
