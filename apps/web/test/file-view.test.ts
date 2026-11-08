import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadable, fileView, lookupAfter } from '../lib/file-view'

const md = { contentType: 'text/markdown', editable: true }
const bigMd = { contentType: 'text/markdown', editable: false }
const csv = { contentType: 'text/csv', editable: true }
const png = { contentType: 'image/png', editable: false }
const pdf = { contentType: 'application/pdf', editable: false }

test('a Markdown document opens in the editor at once, before the API answers', () => {
  // Opened from a mention or a tab kept from before: only its name is known.
  assert.equal(fileView('plan.md', {}, undefined), 'editor')
  assert.equal(fileView('NOTES.MARKDOWN', {}, undefined), 'editor')
  // From the library's list: what it is, said.
  assert.equal(fileView('plan.md', md, undefined), 'editor')
  // And once the API answers.
  assert.equal(fileView('plan.md', {}, md), 'editor')
})

test('a Markdown file too big for the editor is previewed', () => {
  assert.equal(fileView('huge.md', { editable: false }, undefined), 'preview')
  assert.equal(fileView('huge.md', {}, bigMd), 'preview')
  // The API's word wins over what the opener knew.
  assert.equal(fileView('huge.md', md, bigMd), 'preview')
})

test('other text files show as text, the rest as the library previews them', () => {
  assert.equal(fileView('numbers.csv', csv, undefined), 'text')
  assert.equal(fileView('numbers.csv', {}, csv), 'text')
  assert.equal(fileView('logo.png', png, undefined), 'preview')
  assert.equal(fileView('q3.pdf', {}, pdf), 'preview')
  // Whatever its name says, what it is decides.
  assert.equal(fileView('readme.md', {}, { contentType: 'text/plain', editable: true }), 'text')
})

test('a file known only by a name that is not Markdown waits for the API', () => {
  assert.equal(fileView('logo.png', {}, undefined), 'loading')
  assert.equal(fileView('Makefile', {}, undefined), 'loading')
})

test('a file the API no longer has is missing, whatever the opener knew', () => {
  assert.equal(fileView('plan.md', md, null), 'missing')
  assert.equal(fileView('logo.png', png, null), 'missing')
})

test('Download shows for files not edited live as a document', () => {
  assert.deepEqual(
    (['editor', 'text', 'preview', 'loading', 'missing'] as const).map(downloadable),
    [false, true, true, false, false],
  )
})

test('a refresh that fails keeps the file as it was read, so it stays open', () => {
  const csvFile = { path: 'Data/customers.csv', ...csv }
  const read = lookupAfter(undefined, 'f1', { file: csvFile })
  assert.deepEqual(read, { id: 'f1', file: csvFile })
  // The library changed, the refresh fails (a 503): still the CSV, as text, the error noted.
  const failed = lookupAfter(read, 'f1', { error: 'Service Unavailable' })
  assert.deepEqual(failed, { id: 'f1', file: csvFile, error: 'Service Unavailable' })
  assert.equal(fileView('customers.csv', {}, failed.file), 'text')
  // The next refresh that works clears the error.
  assert.deepEqual(lookupAfter(failed, 'f1', { file: csvFile }), { id: 'f1', file: csvFile })
  // Only the API saying it is gone makes it missing, and that too is kept through a failure.
  const gone = lookupAfter(read, 'f1', { gone: true })
  assert.equal(fileView('customers.csv', {}, gone.file), 'missing')
  assert.equal(lookupAfter(gone, 'f1', { error: 'x' }).file, null)
})

test("a failure for another file, or before any answer, keeps nothing of another's", () => {
  const read = lookupAfter(undefined, 'f1', { file: { path: 'a.csv', ...csv } })
  assert.deepEqual(lookupAfter(read, 'f2', { error: 'Bad Gateway' }), {
    id: 'f2',
    error: 'Bad Gateway',
  })
  assert.deepEqual(lookupAfter(undefined, 'f1', { error: 'Bad Gateway' }), {
    id: 'f1',
    error: 'Bad Gateway',
  })
})
