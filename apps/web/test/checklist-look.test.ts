// How a checklist line reads in the document editor (lib/checklist-look).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checklistLook, type Piece } from '../lib/checklist-look'

const plain = (text: string): Piece => ({ text, italic: false, code: false })
const italic = (text: string): Piece => ({ text, italic: true, code: false })
const code = (text: string, inItalic = false): Piece => ({ text, italic: inItalic, code: true })
const br = plain('\n')
const length = (pieces: Piece[]) => pieces.reduce((n, p) => n + p.text.length, 0)

test('a line without italics has no note, with or without its priority dot', () => {
  assert.deepEqual(checklistLook([plain('🔴 Page de statut')]), { note: null })
  assert.deepEqual(checklistLook([plain('Page de statut')]), { note: null })
})

test('italics on a line of their own after a line break are a note, from the break', () => {
  const pieces = [plain('🔴 Sauvegardes Neon.'), br, italic('Vérifié le 26 oct.')]
  assert.deepEqual(checklistLook(pieces), {
    note: { from: '🔴 Sauvegardes Neon.'.length, to: length(pieces) },
  })
})

test('italics at the end of the line itself are not a note', () => {
  assert.equal(checklistLook([plain('Sauvegardes Neon. '), italic('Vérifié.')]).note, null)
  assert.equal(checklistLook([plain('Tester dans '), italic('Safari')]).note, null)
})

test('italics in the middle of the line are not a note', () => {
  assert.equal(checklistLook([plain('Un '), italic('seul'), plain(' runner')]).note, null)
})

test('a line break followed by plain text is not a note', () => {
  assert.equal(checklistLook([plain('Rollback'), br, plain('API et dashboard')]).note, null)
  assert.equal(
    checklistLook([plain('Rollback'), br, italic('à voir'), br, plain('fin')]).note,
    null,
  )
})

test('several notes, each on its own line, make one note', () => {
  const pieces = [
    plain('Gateway redéployée.'),
    br,
    italic('Depuis la PR #414 (table '),
    code('previews'),
    italic('). Ensuite, redémarrer.'),
    br,
    italic('Deuxième commentaire'),
  ]
  assert.deepEqual(checklistLook(pieces).note, {
    from: 'Gateway redéployée.'.length,
    to: length(pieces),
  })
})

test('a note at the end of the line before the break stays in the line', () => {
  const pieces = [plain('Gateway. '), italic('Inline.'), br, italic('Sous la ligne')]
  assert.equal(checklistLook(pieces).note?.from, 'Gateway. Inline.'.length)
})

test('a note may start with code', () => {
  const pieces = [plain('Rate limiting.'), br, code('POST'), italic(' reste à faire')]
  assert.equal(checklistLook(pieces).note?.from, 'Rate limiting.'.length)
})

test('a line that is only a dot, or only italics, has no note', () => {
  assert.equal(checklistLook([plain('🟠'), br, italic('À voir')]).note, null)
  assert.equal(checklistLook([br, italic('À voir')]).note, null)
})

test('code alone on the last line is not a note', () => {
  assert.equal(checklistLook([plain('Clé'), br, code('VAULT_KEY')]).note, null)
})

test('the marker of attached work after the note stays out of it', () => {
  const marker: Piece = { text: '￼', italic: false, code: false, aside: true }
  const pieces = [plain('Anti-abus.'), br, italic('Limites faites.'), marker]
  assert.deepEqual(checklistLook(pieces).note, {
    from: 'Anti-abus.'.length,
    to: 'Anti-abus.\nLimites faites.'.length,
  })
})
