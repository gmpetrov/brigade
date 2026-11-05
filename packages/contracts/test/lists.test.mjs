import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GETTING_STARTED,
  documentFileId,
  documentFilePath,
  findLine,
  newListPath,
  newListText,
  handOffMessage,
  handOffParts,
  hasHeading,
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

test("a line or a note Brigade writes keeps no comment: never another line's marker", () => {
  const list = parseList(doc)
  // Words that carry another line's marker, and an open comment that would hide what follows.
  const forged = insertLine(
    doc,
    list,
    { section: '3. security' },
    'Audit <!-- item:bbbbbbbbbbbbbbbb --> then <!--',
    'gggggggggggggggg',
  )
  assert.equal(forged.split('\n').at(-1), '* [ ] Audit then <!-- item:gggggggggggggggg -->')
  const read = parseList(forged)
  assert.equal(read.lines[1].id, 'bbbbbbbbbbbbbbbb')
  assert.equal(read.lines.at(-1).id, 'gggggggggggggggg')
  const noted = setLineDone(doc, list.lines[3], true, 'Done <!-- item:bbbbbbbbbbbbbbbb -->')
  assert.equal(noted.split('\n')[9], '* [x] 🟠 Documented rollback *Done*')
  assert.equal(parseList(noted).lines[1].id, 'bbbbbbbbbbbbbbbb')
})

test('a heading is found by its name, case, spaces and Markdown aside', () => {
  assert.equal(hasHeading(doc, '3. security'), true)
  assert.equal(hasHeading(doc, '  2.  TECH '), true)
  assert.equal(hasHeading(doc, 'Ideas'), false)
  // A checklist line is no heading.
  assert.equal(hasHeading(doc, 'SECURITY.md'), false)
})

test('a heading in a fenced example is no section: neither found nor written under', () => {
  const fenced = [
    '# Backlog',
    '',
    '```md',
    '## Ideas',
    '```',
    '',
    '## To Do',
    '',
    '* [ ] Approved',
  ].join('\n')
  assert.equal(hasHeading(fenced, 'Ideas'), false)
  // An example before the real heading: the line goes under the real one.
  const both = `${fenced}\n\n## Ideas\n`
  assert.equal(hasHeading(both, 'Ideas'), true)
  const added = insertLine(
    both,
    parseList(both),
    { section: 'Ideas' },
    'An idea',
    'iiiiiiiiiiiiiiii',
  )
  const line = parseList(added).lines.find((l) => l.id === 'iiiiiiiiiiiiiiii')
  assert.equal(line?.section, 'Ideas')
  assert.ok(added.endsWith('## Ideas\n\n* [ ] An idea <!-- item:iiiiiiiiiiiiiiii -->\n'))
  // The fenced example's heading stays as it was, with nothing put in the block.
  assert.deepEqual(added.split('\n').slice(2, 5), ['```md', '## Ideas', '```'])
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

test('a line whose text goes on below (a line break typed in it) keeps its marker', () => {
  // As the editor saves a line where someone typed Shift+Enter before its chips.
  const broken = [
    '* [x] Public docs: quickstart, FAQ. *PR #501, 30 Oct* \\',
    '<!-- item:aaaaaaaaaaaaaaaa -->\\',
    '',
    '  * [ ] Propose a structure <!-- item:bbbbbbbbbbbbbbbb -->',
    '* [ ] Pricing page',
    'with the plans  ',
    'and what each includes',
    '* [ ] Demo video',
  ].join('\n')
  const list = parseList(broken)
  assert.deepEqual(
    list.lines.map((l) => [l.line, l.end, l.id, l.text]),
    [
      [0, 1, 'aaaaaaaaaaaaaaaa', 'Public docs: quickstart, FAQ. *PR #501, 30 Oct*'],
      [3, 3, 'bbbbbbbbbbbbbbbb', 'Propose a structure'],
      [4, 6, null, 'Pricing page with the plans and what each includes'],
      [7, 7, null, 'Demo video'],
    ],
  )
  // Ticked with a note: on its first row, before the line break, which stays.
  const pricing = setLineDone(broken, list.lines[2], true, 'Live, 30 Oct')
  assert.equal(pricing.split('\n')[4], '* [x] Pricing page *Live, 30 Oct*')
  const unticked = setLineDone(broken, list.lines[0], false)
  assert.equal(unticked.split('\n')[0], '* [ ] Public docs: quickstart, FAQ. *PR #501, 30 Oct* \\')
  const noted = setLineDone(unticked, parseList(unticked).lines[0], true, 'Done')
  assert.equal(
    noted.split('\n')[0],
    '* [x] Public docs: quickstart, FAQ. *PR #501, 30 Oct* *Done* \\',
  )
  assert.equal(parseList(noted).lines[0].id, 'aaaaaaaaaaaaaaaa')
  // Marked: at the end of its first row, before its line break.
  const marked = markLine(broken, list.lines[2], 'cccccccccccccccc')
  assert.equal(marked.split('\n')[4], '* [ ] Pricing page <!-- item:cccccccccccccccc -->')
  assert.equal(parseList(marked).lines[2].id, 'cccccccccccccccc')
  // A new line under it goes after all its rows, not between them.
  const nested = insertLine(
    broken,
    list,
    { after: list.lines[2], nested: true },
    'Prices',
    'dddddddddddddddd',
  )
  assert.equal(nested.split('\n')[7], '  * [ ] Prices <!-- item:dddddddddddddddd -->')
  assert.equal(
    parseList(nested).lines[2].text,
    'Pricing page with the plans and what each includes',
  )
})

test('a note with a link is not put in italics, which the editor breaks a little more each save', () => {
  const list = parseList(doc)
  const ticked = setLineDone(doc, list.lines[1], true, 'Live at www.brigade.lol/docs, 30 Oct')
  assert.equal(
    ticked.split('\n')[7],
    '* [x] 🔴 Neon backups: **7 days** and a tested restore. — Live at www.brigade.lol/docs, 30 Oct <!-- item:bbbbbbbbbbbbbbbb -->',
  )
})

test('handing lines over is a request naming the list, or the person’s note, then the lines', () => {
  const file = { id: 'doc1', path: 'Projects/Acme/launch.md' }
  assert.equal(
    handOffMessage(file, ['**Docs**: FAQ', 'Pricing']),
    'Please take these items of @[Projects/Acme/launch.md](document:doc1):\n\n- Docs: FAQ\n- Pricing',
  )
  assert.equal(
    handOffMessage(file, ['Pricing'], '  Start with this one. '),
    'Start with this one.\n\n- Pricing',
  )
})

test('a hand-off with no note of the person’s reads back as its file and lines', () => {
  const file = { id: 'doc1', path: 'Projects/Acme/launch.md' }
  assert.deepEqual(handOffParts(handOffMessage(file, ['**Docs**: FAQ', 'Pricing'])), {
    file,
    items: ['Docs: FAQ', 'Pricing'],
  })
  assert.deepEqual(handOffParts(handOffMessage(file, ['🔴 Invite: « Invite them » (PR #531).'])), {
    file,
    items: ['🔴 Invite: « Invite them » (PR #531).'],
  })
  // The person's own words stay theirs, as does anything else.
  assert.equal(handOffParts(handOffMessage(file, ['Pricing'], 'Start with this one.')), null)
  assert.equal(handOffParts('Please take this item of the list: pricing'), null)
})

// A line's files (docs/lists.md): uploads of the document on rows of their own, indented under the
// line's text as the editor writes them (@brigade/editor).
const withFiles = [
  '# Launch',
  '',
  '* [ ] Voice: Cartesia or Georges <!-- item:aaaaaaaaaaaaaaaa -->',
  '',
  '  ![Screenshot 2026-11-05 at 16.34.14.png](asset:cmw3pp1mb000spsp71tl0omrb)',
  '',
  '  [brief.pdf](asset:cmfile00000000000000000001 "file: Q3")',
  '',
  '* [ ] References <!-- item:bbbbbbbbbbbbbbbb -->',
  '  * [ ] Two films <!-- item:cccccccccccccccc -->',
  '',
  '    [clip.mp4](asset:cmclip00000000000000000001 "video")',
  '',
  '  ![poster.png](asset:cmposter000000000000000001)',
  '* [ ] Not this one',
  '',
  '![Loose screenshot.png](asset:cmloose00000000000000000001)',
  '',
  '- A plain bullet',
  '',
  '  ![its own.png](asset:cmbullet0000000000000000001)',
  '',
  '* [ ] Its text [links to a file](asset:cmlink000000000000000000001)',
].join('\n')

test('the files indented under a line are its own, and never its text', () => {
  const lines = parseList(withFiles).lines
  assert.deepEqual(
    lines.map((l) => [l.text, l.files.map((f) => [f.id, f.name, f.kind]), l.last]),
    [
      [
        'Voice: Cartesia or Georges',
        [
          ['cmw3pp1mb000spsp71tl0omrb', 'Screenshot 2026-11-05 at 16.34.14.png', 'image'],
          ['cmfile00000000000000000001', 'brief.pdf', 'file'],
        ],
        6,
      ],
      // Under the nested line: its own file; less indented, after it: the line above's.
      ['References', [['cmposter000000000000000001', 'poster.png', 'image']], 13],
      ['Two films', [['cmclip00000000000000000001', 'clip.mp4', 'video']], 11],
      // A file at the margin is the document's own, as is one under a plain bullet.
      ['Not this one', [], 14],
      // A link to a file in a line's text stays its text.
      ['Its text [links to a file](asset:cmlink000000000000000000001)', [], 22],
    ],
  )
})

test('a file under a line whose text goes on below its box is still its own', () => {
  const text = [
    '* [ ] Its text goes on\\',
    'on a second row',
    '',
    '  ![a.png](asset:cma)',
    '* [ ] Next',
  ].join('\n')
  assert.deepEqual(
    parseList(text).lines.map((l) => [l.text, l.files.map((f) => f.id), l.end, l.last]),
    [
      ['Its text goes on on a second row', ['cma'], 1, 3],
      ['Next', [], 4, 4],
    ],
  )
})

test('a line added beside one with files goes after them, and one under it right under its text', () => {
  const list = parseList(withFiles)
  const beside = insertLine(withFiles, list, { after: list.lines[0] }, 'Music', 'dddddddddddddddd')
  const after = parseList(beside).lines
  assert.equal(beside.split('\n')[7], '* [ ] Music <!-- item:dddddddddddddddd -->')
  assert.deepEqual(
    after.slice(0, 2).map((l) => [l.text, l.files.length]),
    [
      ['Voice: Cartesia or Georges', 2],
      ['Music', 0],
    ],
  )
  // Beside a line with lines and files under it: after them all.
  const second = insertLine(
    withFiles,
    list,
    { after: list.lines[1] },
    'Credits',
    'eeeeeeeeeeeeeeee',
  )
  assert.equal(second.split('\n')[14], '* [ ] Credits <!-- item:eeeeeeeeeeeeeeee -->')
  assert.deepEqual(
    parseList(second)
      .lines.map((l) => [l.text, l.files.length])
      .slice(1, 4),
    [
      ['References', 1],
      ['Two films', 1],
      ['Credits', 0],
    ],
  )
  // Under it: right under its text; its files stay its own.
  const under = insertLine(
    withFiles,
    list,
    { after: list.lines[0], nested: true },
    'Ask Georges',
    'ffffffffffffffff',
  )
  assert.equal(under.split('\n')[3], '  * [ ] Ask Georges <!-- item:ffffffffffffffff -->')
  assert.deepEqual(
    parseList(under)
      .lines.slice(0, 2)
      .map((l) => [l.text, l.files.length]),
    [
      ['Voice: Cartesia or Georges', 2],
      ['Ask Georges', 0],
    ],
  )
  // At the end of a section whose last line has files: after them.
  const sectioned = [
    '## Sound',
    '',
    '* [ ] Voice',
    '',
    '  ![a.png](asset:cma)',
    '',
    '## Next',
  ].join('\n')
  const added = insertLine(
    sectioned,
    parseList(sectioned),
    { section: 'Sound' },
    'Music',
    'gggggggggggggggg',
  )
  assert.equal(added.split('\n')[5], '* [ ] Music <!-- item:gggggggggggggggg -->')
  assert.deepEqual(
    parseList(added).lines.map((l) => [l.text, l.files.length]),
    [
      ['Voice', 1],
      ['Music', 0],
    ],
  )
})

test('a line handed over takes the paths of its files, which read back with it', () => {
  const file = { id: 'doc1', path: 'Projects/Acme/launch.md' }
  const path = documentFilePath(file.path, { id: 'cmw3pp1mb000spsp71tl0omrb', name: 'Shot 1.png' })
  assert.equal(path, 'Projects/Acme/launch.md.files/cmw3pp1mb000spsp71tl0omrb/Shot 1.png')
  assert.equal(documentFileId(path), 'cmw3pp1mb000spsp71tl0omrb')
  assert.equal(documentFileId('Projects/Acme/launch.md'), null)
  const message = handOffMessage(file, [{ text: 'Voice', files: [path] }, 'Pricing'])
  assert.equal(
    message,
    'Please take these items of @[Projects/Acme/launch.md](document:doc1):\n\n' +
      `- Voice\n  - File in the library: ${path}\n- Pricing`,
  )
  assert.deepEqual(handOffParts(message), { file, items: ['Voice', 'Pricing'], files: [path] })
  // With the person's note, the files still go under their line.
  assert.equal(
    handOffMessage(file, [{ text: 'Voice', files: [path] }], 'Look at the screenshot.'),
    `Look at the screenshot.\n\n- Voice\n  - File in the library: ${path}`,
  )
})

for (const block of [
  '> A separate quote',
  '---\nA separate paragraph',
  '<details>Notes</details>',
]) {
  test(`a block of its own ends a line's text: ${block.split('\n')[0]}`, () => {
    const source = `* [ ] Parent\n${block}\n* [ ] Next`
    const list = parseList(source)
    assert.equal(list.lines[0].end, 0)
    assert.equal(list.lines[0].text, 'Parent')
    const nested = insertLine(
      source,
      list,
      { after: list.lines[0], nested: true },
      'Child',
      'bbbbbbbbbbbbbbbb',
    )
    assert.equal(nested.split('\n')[1], '  * [ ] Child <!-- item:bbbbbbbbbbbbbbbb -->')
  })
}

test('a new list is a file named after it, at the root or in a project folder', () => {
  assert.equal(newListPath('Launch plan!'), 'launch-plan.md')
  assert.equal(newListPath('Été 2027', 'Projects/Acme'), 'Projects/Acme/ete-2027.md')
  assert.equal(newListPath('Roadmap', 'Projects/Acme/'), 'Projects/Acme/roadmap.md')
  assert.equal(newListPath('!!!'), 'list.md')
  const list = parseList(newListText('Launch plan'))
  assert.equal(list.title, 'Launch plan')
})

test('the Getting started list has its setup line and five lines in all', () => {
  const list = parseList(GETTING_STARTED.text)
  assert.equal(list.title, 'Getting started')
  assert.equal(list.lines.length, 5)
  assert.equal(list.lines[0].text, GETTING_STARTED.setupLine)
  assert.ok(list.lines.every((l) => !l.done && !l.marker))
})
