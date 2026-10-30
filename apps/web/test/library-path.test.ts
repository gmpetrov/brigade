import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderNamed, folderSuggestions, splitTyped } from '../lib/library-path'

const folders = [
  'Projects',
  'Projects/Brigade',
  'Projects/Brigade/proposals',
  'Projects/Askli',
  'Projects/Lovarank',
  'design-systems',
]

test('offers the folders of the level shown, those starting with the text first', () => {
  assert.deepEqual(folderSuggestions(folders, '', 'pro'), ['Projects'])
  assert.deepEqual(folderSuggestions(folders, 'Projects', ''), ['Askli', 'Brigade', 'Lovarank'])
  assert.deepEqual(folderSuggestions(folders, 'Projects', 'a'), ['Askli', 'Brigade', 'Lovarank'])
  assert.deepEqual(folderSuggestions(folders, 'Projects', 'BRI'), ['Brigade'])
  assert.deepEqual(folderSuggestions(folders, 'Projects', 'test.md'), [])
})

test('spells a folder as the existing one, whatever the case typed', () => {
  assert.equal(folderNamed(folders, 'Projects', 'brigade'), 'Brigade')
  assert.equal(folderNamed(folders, 'Projects', 'specs'), 'specs')
})

test('turns a typed or pasted path into folders and a name', () => {
  assert.deepEqual(splitTyped(folders, [], 'test.md'), { segments: [], text: 'test.md' })
  assert.deepEqual(splitTyped(folders, [], 'projects/'), { segments: ['Projects'], text: '' })
  assert.deepEqual(splitTyped(folders, [], 'projects/brigade/test.md'), {
    segments: ['Projects', 'Brigade'],
    text: 'test.md',
  })
  assert.deepEqual(splitTyped(folders, ['Projects'], 'brigade//specs/a.md'), {
    segments: ['Projects', 'Brigade', 'specs'],
    text: 'a.md',
  })
  assert.deepEqual(splitTyped(folders, [], '/'), { segments: [], text: '' })
})
