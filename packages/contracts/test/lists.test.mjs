import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findLine,
  insertLine,
  listCounts,
  markLine,
  newListItemId,
  parseList,
  plainItemText,
  setLineDone,
} from '../dist/index.js'

const doc = [
  '# Release checklist',
  '',
  'Legend: 🔴 blocking',
  '',
  '## 2. Tech',
  '',
  '* [x] 🔴 Monitoring and alerts. *PR #483, 29 Oct* <!-- item:aaaaaaaaaaaaaaaa -->',
  '* [ ] 🔴 Neon backups: **7 days** and a tested restore. <!-- item:bbbbbbbbbbbbbbbb -->',
  '  * [ ] Snapshot every day',
  '* [ ] 🟠 Documented rollback',
  '',
  '```md',
  '* [ ] not an item, in code',
  '```',
  '',
  '## 3. Security',
  '',
  '- [X] SECURITY.md',
  '1. [ ] Rate limiting',
].join('\n')

test('a checklist reads as lines, ticked or not, with their ids and sections', () => {
  const list = parseList(doc)
  assert.equal(list.title, 'Release checklist')
  assert.deepEqual(
    list.lines.map((l) => [l.line, l.indent, l.done, l.id, l.section]),
    [
      [6, 0, true, 'aaaaaaaaaaaaaaaa', '2. Tech'],
      [7, 0, false, 'bbbbbbbbbbbbbbbb', '2. Tech'],
      [8, 2, false, null, '2. Tech'],
      [9, 0, false, null, '2. Tech'],
      [17, 0, true, null, '3. Security'],
      [18, 0, false, null, '3. Security'],
    ],
  )
  assert.equal(list.lines[1].text, '🔴 Neon backups: **7 days** and a tested restore.')
  assert.equal(plainItemText(list.lines[1].text), '🔴 Neon backups: 7 days and a tested restore.')
  assert.deepEqual(listCounts(list), { done: 2, total: 6 })
})

test('a line is found by its id, its whole text or the start of it, never by a guess', () => {
  const list = parseList(doc)
  assert.equal(findLine(list, 'bbbbbbbbbbbbbbbb').line, 7)
  assert.equal(findLine(list, '🟠 documented ROLLBACK').line, 9)
  assert.equal(findLine(list, 'Neon backups').line, 7)
  assert.match(findLine(list, 'Nothing like this'), /No checklist line/)
  // SECURITY.md and "Snapshot every day" both start so.
  assert.match(findLine(list, 's'), /2 checklist lines match/)
})

test('ticking changes only its box, and a note goes before the marker', () => {
  const list = parseList(doc)
  const ticked = setLineDone(doc, list.lines[1], true, 'PR #490, 29 Oct')
  const line = ticked.split('\n')[7]
  assert.equal(
    line,
    '* [x] 🔴 Neon backups: **7 days** and a tested restore. *PR #490, 29 Oct* <!-- item:bbbbbbbbbbbbbbbb -->',
  )
  assert.equal(ticked.split('\n').length, doc.split('\n').length)
  const unticked = setLineDone(doc, list.lines[4], false)
  assert.equal(unticked.split('\n')[17], '- [ ] SECURITY.md')
})

test('a line gets a marker once', () => {
  const list = parseList(doc)
  const marked = markLine(doc, list.lines[3], 'cccccccccccccccc')
  assert.equal(marked.split('\n')[9], '* [ ] 🟠 Documented rollback <!-- item:cccccccccccccccc -->')
  assert.equal(parseList(marked).lines[3].id, 'cccccccccccccccc')
  assert.equal(markLine(doc, list.lines[0], 'dddddddddddddddd'), doc)
})

test('a new line goes after another (past its nested lines), under it, in a section or at the end', () => {
  const list = parseList(doc)
  const after = insertLine(doc, list, { after: list.lines[1] }, 'Restore drill', 'eeeeeeeeeeeeeeee')
  assert.equal(after.split('\n')[9], '* [ ] Restore drill <!-- item:eeeeeeeeeeeeeeee -->')
  const nested = insertLine(
    doc,
    list,
    { after: list.lines[1], nested: true },
    'Check PITR',
    'ffffffffffffffff',
  )
  assert.equal(nested.split('\n')[8], '  * [ ] Check PITR <!-- item:ffffffffffffffff -->')
  const section = insertLine(doc, list, { section: '3. security' }, 'Audit', 'gggggggggggggggg')
  assert.equal(section.split('\n').at(-1), '* [ ] Audit <!-- item:gggggggggggggggg -->')
  const end = insertLine(`${doc}\n\n`, list, {}, 'Last', 'hhhhhhhhhhhhhhhh')
  assert.equal(end.split('\n')[19], '* [ ] Last <!-- item:hhhhhhhhhhhhhhhh -->')
  assert.equal(parseList(end).lines.at(-1).id, 'hhhhhhhhhhhhhhhh')
})

test('new ids are 16 characters of [a-z0-9]', () => {
  const id = newListItemId()
  assert.match(id, /^[a-z0-9]{16}$/)
  assert.notEqual(id, newListItemId())
})

test('a line copied with its marker is a new line: the first keeps the id', () => {
  const copied = [
    '* [x] Original <!-- item:aaaaaaaaaaaaaaaa -->',
    '* [ ] Copied and reworded <!-- item:aaaaaaaaaaaaaaaa -->',
  ].join('\n')
  const list = parseList(copied)
  assert.deepEqual(
    list.lines.map((l) => [l.id, l.marker]),
    [
      ['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa'],
      [null, 'aaaaaaaaaaaaaaaa'],
    ],
  )
  assert.equal(findLine(list, 'aaaaaaaaaaaaaaaa').line, 0)
  // Marked, the copy gets an id of its own in place of the one it carried.
  const marked = markLine(copied, list.lines[1], 'bbbbbbbbbbbbbbbb')
  assert.equal(marked.split('\n')[1], '* [ ] Copied and reworded <!-- item:bbbbbbbbbbbbbbbb -->')
  assert.deepEqual(
    parseList(marked).lines.map((l) => l.id),
    ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
  )
})
