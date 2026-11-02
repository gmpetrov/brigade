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
  assert.equal(checklistLook([plain('🔴 Page de statut')]).note, null)
  assert.equal(checklistLook([plain('Page de statut')]).note, null)
})

test('italics on a line of their own after a line break are a note, from the break', () => {
  const pieces = [plain('🔴 Sauvegardes Neon.'), br, italic('Vérifié le 26 oct.')]
  assert.deepEqual(checklistLook(pieces).note, {
    from: '🔴 Sauvegardes Neon.'.length,
    to: length(pieces),
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

// A line's title and its details (folded under it in the editor).
const DETAILS = 'PostHog issue 01a191b0, 3 times on Oct 31 between 11:20 and 11:25 UTC.'

test('a long line folds what follows its title, from the colon', () => {
  const title = '⌘K search fails for short words ("#12", "pr")'
  const pieces = [plain(`${title}: ${DETAILS}`)]
  assert.deepEqual(checklistLook(pieces).detail, { from: title.length, to: length(pieces) })
})

test('a short line, or short details, do not fold', () => {
  assert.equal(checklistLook([plain('Page de statut')]).detail, null)
  assert.equal(checklistLook([plain('Rollback: API et dashboard')]).detail, null)
})

test('the colon of a link or a time does not end the title', () => {
  const title = 'Alert at 11:20 from https://eu.posthog.com/x'
  const pieces = [plain(`${title}: ${DETAILS}`)]
  assert.equal(checklistLook(pieces).detail?.from, title.length)
})

test('a colon inside code does not end the title', () => {
  const pieces = [plain('Set '), code('a: b'), plain(` in the config: ${DETAILS}`)]
  assert.equal(checklistLook(pieces).detail?.from, 'Set a: b in the config'.length)
})

test('a line whose first colon is its Done when folds from Done when', () => {
  const title = 'Add lint to the dashboard. '
  const pieces = [plain(`${title}Done when: ${DETAILS}`)]
  assert.deepEqual(checklistLook(pieces).detail, { from: title.length, to: length(pieces) })
})

test('a label before the colon is not a title', () => {
  assert.equal(checklistLook([plain(`PR: ${DETAILS}`)]).detail, null)
  assert.equal(checklistLook([plain(`🔴 Done when: ${DETAILS}`)]).detail, null)
})

test('the title may follow a priority dot', () => {
  const pieces = [plain(`🔴 Backups: ${DETAILS}`)]
  assert.equal(checklistLook(pieces).detail?.from, '🔴 Backups'.length)
})

test('details stop before the closing notes and the marker of attached work', () => {
  const marker: Piece = { text: '￼', italic: false, code: false, aside: true }
  const line = `Search fails: ${DETAILS}`
  const withNote = [plain(line), br, italic('Checked Nov 2.'), marker]
  assert.deepEqual(checklistLook(withNote).detail, { from: 'Search fails'.length, to: line.length })
  const withMarker = [plain(line), marker]
  assert.deepEqual(checklistLook(withMarker).detail, {
    from: 'Search fails'.length,
    to: line.length,
  })
})

test('italics at the end of the details stay in them', () => {
  const pieces = [plain(`Search fails: ${DETAILS} `), italic('PR #591, 1 Nov')]
  assert.equal(checklistLook(pieces).detail?.to, length(pieces))
})

test('a colon at the end of a formatted run needs the space after it', () => {
  const bold = (text: string): Piece => ({ text, italic: false, code: false })
  const pieces = [plain('Meet at '), bold('11:'), plain(`20 tomorrow: ${DETAILS}`)]
  assert.equal(checklistLook(pieces).detail?.from, 'Meet at 11:20 tomorrow'.length)
})
