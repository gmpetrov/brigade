// How a checklist line reads in the document editor (lib/checklist-look).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checklistLook, type Piece } from '../lib/checklist-look'

const plain = (text: string): Piece => ({ text, italic: false, code: false })
const italic = (text: string): Piece => ({ text, italic: true, code: false })
const code = (text: string, inItalic = false): Piece => ({ text, italic: inItalic, code: true })

test('a line without italics has no note, with or without its priority dot', () => {
  assert.deepEqual(checklistLook([plain('🔴 Page de statut')]), { note: null })
  assert.deepEqual(checklistLook([plain('Page de statut')]), { note: null })
})

test('a closing note in italics starts a line of its own', () => {
  const pieces = [plain('🔴 Sauvegardes Neon. '), italic('Vérifié le 26 oct.')]
  const from = 'Sauvegardes Neon. '.length + 3
  assert.deepEqual(checklistLook(pieces), {
    note: { from, to: from + 'Vérifié le 26 oct.'.length },
  })
})

test('code between italics stays in the note', () => {
  const pieces = [
    plain('Gateway redéployée. '),
    italic('Depuis la PR #414 (table '),
    code('previews'),
    italic('). Ensuite, redémarrer.'),
  ]
  assert.equal(checklistLook(pieces).note?.from, 'Gateway redéployée. '.length)
})

test('the note starts at its words, not at code before them', () => {
  const pieces = [plain('Rate limiting. '), code('POST'), italic(' reste à faire')]
  assert.equal(checklistLook(pieces).note?.from, 'Rate limiting. POST'.length)
})

test('italics in the middle of the line are not a note', () => {
  assert.equal(checklistLook([plain('Un '), italic('seul'), plain(' runner')]).note, null)
})

test('a line all in italics has no note', () => {
  assert.equal(checklistLook([plain('🟠 '), italic('À voir')]).note, null)
  assert.equal(checklistLook([italic('À voir')]).note, null)
})

test('code alone at the end is not a note', () => {
  assert.equal(checklistLook([plain('Clé '), code('VAULT_KEY')]).note, null)
})

test('an italic code span counts as part of the note', () => {
  const pieces = [
    plain('TVA. '),
    italic('Aucune taxe ('),
    code('automatic_tax', true),
    italic(').'),
  ]
  assert.equal(checklistLook(pieces).note?.from, 'TVA. '.length)
})

test('the marker of attached work after the note leaves the note as it is', () => {
  const marker: Piece = { text: '￼', italic: false, code: false, aside: true }
  const pieces = [plain('Anti-abus. '), italic('Limites faites.'), marker]
  assert.deepEqual(checklistLook(pieces).note, {
    from: 'Anti-abus. '.length,
    to: 'Anti-abus. Limites faites.'.length,
  })
  assert.equal(checklistLook([plain('Anti-abus.'), marker]).note, null)
})
