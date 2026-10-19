import assert from 'node:assert/strict'
import { test } from 'node:test'
import { libraryAccessFor, type FolderRule } from '@brigade/contracts'
import { libraryChangeRefusal, type LibraryChange } from '../src/library-changes.js'

const rules: FolderRule[] = [
  { path: 'hr', restricted: true, grants: {} },
  { path: 'specs/frozen', restricted: false, grants: { riley: 'read' } },
]
const access = (path: string) =>
  libraryAccessFor(path, { id: 'riley', library: 'read_write' }, rules)
const change = (c: Partial<LibraryChange> & { path: string }): LibraryChange => ({
  files: [],
  ruled: [],
  projects: [],
  ...c,
})
const refuse = (c: Partial<LibraryChange> & { path: string }) =>
  libraryChangeRefusal('Riley', access, change(c))

test('a file it may save to moves and deletes', () => {
  assert.equal(refuse({ path: 'Projects/Brigade/boucles-spec.md' }), null)
  assert.equal(
    refuse({
      path: 'Projects/Brigade/playbooks-spec.md',
      to: 'Projects/Brigade/Playbooks/spec.md',
    }),
    null,
  )
})

test('a folder moves with every file in it', () => {
  const files = ['Projects/Brigade/screenshots/a.png', 'Projects/Brigade/screenshots/b.png']
  assert.equal(
    refuse({
      path: 'Projects/Brigade/screenshots',
      to: 'Projects/Brigade/Work/screenshots',
      files,
    }),
    null,
  )
  assert.match(
    refuse({
      path: 'Projects/Brigade/screenshots',
      to: 'Projects/Brigade/screenshots/old',
      files,
    })!,
    /inside itself/,
  )
})

test('nothing in or out of a folder it may only read, or not reach', () => {
  assert.match(refuse({ path: 'specs/frozen/a.md' })!, /may read specs\/frozen\/a\.md but not/)
  assert.match(refuse({ path: 'notes/a.md', to: 'specs/frozen/a.md' })!, /may read/)
  assert.match(refuse({ path: 'notes/a.md', to: 'hr/a.md' })!, /no access/)
  assert.match(refuse({ path: 'specs', files: ['specs/a.md', 'specs/frozen/b.md'] })!, /may read/)
})

test("a folder with access rules, or a project's, stays where people put it", () => {
  assert.match(
    refuse({ path: 'hr', ruled: ['hr'] })!,
    /^hr has access rules for teammates: only a person can delete it, from the library\.$/,
  )
  assert.match(
    refuse({ path: 'specs', ruled: ['specs/frozen'], files: ['specs/a.md'] })!,
    /specs holds specs\/frozen, which has access rules for teammates: only a person can delete specs,/,
  )
  assert.match(
    refuse({
      path: 'Projects',
      to: 'Old',
      projects: [{ name: 'Brigade', folder: 'Projects/Brigade' }],
    })!,
    /Projects holds Projects\/Brigade, which is the folder of the project Brigade: only a person can move Projects,/,
  )
})
