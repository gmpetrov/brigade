// A list item's marker (docs/lists.md) survives the editor: Markdown to the live document and
// back, as the collab server does with every save, and an edit applied to a live document.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseList } from '@brigade/contracts'
import { normalizeMarkdown } from '../src/collab.js'

test('a checklist line keeps its marker through the editor, and so does its text after it', async () => {
  const text = [
    '# Launch',
    '',
    '* [ ] Neon backups <!-- item:aaaaaaaaaaaaaaaa -->',
    '* [x] Monitoring *PR #483* <!-- item:bbbbbbbbbbbbbbbb -->',
    '* [ ] Rollback, with @[plan.md](document:ck123) <!-- item:cccccccccccccccc --> and more',
    '* [ ] No marker',
    '',
  ].join('\n')
  const once = await normalizeMarkdown(text)
  assert.equal(await normalizeMarkdown(once), once, 'stable')
  const lines = parseList(once).lines
  assert.deepEqual(
    lines.map((l) => [l.id, l.done]),
    [
      ['aaaaaaaaaaaaaaaa', false],
      ['bbbbbbbbbbbbbbbb', true],
      ['cccccccccccccccc', false],
      [null, false],
    ],
  )
  assert.match(once, /<!-- item:aaaaaaaaaaaaaaaa -->/)
  assert.equal(lines[2].text, 'Rollback, with @[plan.md](document:ck123) and more')
})
