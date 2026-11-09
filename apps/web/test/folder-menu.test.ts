import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile } from '@brigade/contracts'
import {
  FOLDER_MENU_MATCHES,
  folderEntries,
  folderMatches,
  makeRoom,
  pathFolders,
} from '../lib/folder-menu'

const file = (path: string, contentType = 'text/markdown', editable = true): LibraryFile => ({
  id: path,
  path,
  contentType,
  size: 1,
  indexed: true,
  editable,
  updatedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
})

const files = [
  file('Projects/Brigade/backlog.md'),
  file('Projects/Brigade/decisions/missions-spec.md'),
  file('Projects/Brigade/decisions/README.md'),
  file('Projects/Brigade/decisions/apps-proposal.md'),
  file('Projects/Brigade/decisions/landing-page/01-research.md'),
  file('Projects/Brigade/decisions/landing-page/11-narrative.md'),
  file('Projects/Brigade/decisions/flow.pdf', 'application/pdf', false),
  file('Projects/Brigade/decisions/huge.md', 'text/markdown', false),
  file('Projects/Brigade/designs/inbox.design/index.html', 'text/html'),
  file('Projects/Brigade/designs/inbox.design/notes.md'),
  file('Projects/Brigade/designs/pricing.options/a-bold.design/index.html', 'text/html'),
  file('Projects/Askli/plan.md'),
]

const names = (entries: ReturnType<typeof folderEntries>) =>
  entries.map((e) => `${e.kind}:${e.name}`)

test("a folder's menu lists its folders, then its files, each by name", () => {
  assert.deepEqual(names(folderEntries(files, 'Projects/Brigade/decisions')), [
    'folder:landing-page',
    'file:apps-proposal.md',
    'file:flow.pdf',
    'file:huge.md',
    'file:missions-spec.md',
    'file:README.md',
  ])
  assert.deepEqual(names(folderEntries(files, 'Projects')), ['folder:Askli', 'folder:Brigade'])
  assert.deepEqual(names(folderEntries(files, '')), ['folder:Projects'])
})

test('a design is one entry, and what is in it is not listed', () => {
  assert.deepEqual(names(folderEntries(files, 'Projects/Brigade/designs')), [
    'design:inbox.design',
    'folder:pricing.options',
  ])
  assert.deepEqual(names(folderEntries(files, 'Projects/Brigade/designs/pricing.options')), [
    'design:a-bold.design',
  ])
})

test('a folder whose name starts like another is not taken for it', () => {
  const entries = folderEntries([file('a/bc/x.md'), file('a/b/y.md')], 'a/b')
  assert.deepEqual(names(entries), ['file:y.md'])
})

test('a filter finds files anywhere under the folder, named from there, best first', () => {
  assert.deepEqual(names(folderMatches(files, 'Projects/Brigade/decisions', 'NARR')), [
    'file:landing-page/11-narrative.md',
  ])
  // Names starting with it before those holding it.
  assert.deepEqual(
    names(
      folderMatches([file('x/a-spec.md'), file('x/spec.md'), file('x/b-spec.md')], 'x', 'spec'),
    ),
    ['file:spec.md', 'file:a-spec.md', 'file:b-spec.md'],
  )
  // Only the file's own name counts, not its folders'; and nothing inside a design.
  assert.deepEqual(names(folderMatches(files, 'Projects/Brigade', 'landing')), [])
  assert.deepEqual(names(folderMatches(files, 'Projects/Brigade', 'notes')), [])
  // Blank: the folder as it is.
  assert.deepEqual(
    folderMatches(files, 'Projects/Brigade/decisions', '  '),
    folderEntries(files, 'Projects/Brigade/decisions'),
  )
})

test('a filter shows at most so many files', () => {
  const many = Array.from({ length: FOLDER_MENU_MATCHES + 5 }, (_, i) => file(`x/note-${i}.md`))
  assert.equal(folderMatches(many, 'x', 'note').length, FOLDER_MENU_MATCHES)
})

test("a path's folders, from the top", () => {
  assert.deepEqual(pathFolders('Projects/Brigade/decisions'), [
    { name: 'Projects', path: 'Projects' },
    { name: 'Brigade', path: 'Projects/Brigade' },
    { name: 'decisions', path: 'Projects/Brigade/decisions' },
  ])
  assert.deepEqual(pathFolders(''), [])
})

test('going to the library, the panel steps aside where it would cover the page', () => {
  // Below wide screens it covers the page (a phone, a tablet): it waits in its pill.
  assert.equal(makeRoom(false, false), 'minimize')
  assert.equal(makeRoom(false, true), 'minimize')
  // On a wide screen it sits beside the page, unless laid over the whole window.
  assert.equal(makeRoom(true, true), 'unexpand')
  assert.equal(makeRoom(true, false), 'none')
})
