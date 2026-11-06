import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callFiles, filesFieldsOf, withUploads } from '../src/harness/call-files.js'

test("a single path (Drive's upload file) is uploaded and replaced by its id, not a list", () => {
  const { paths, place } = callFiles('out/report.xlsx')
  assert.deepEqual(paths, ['out/report.xlsx'])
  assert.equal(place(['att-1']), 'att-1')
})

test("a list of paths (an email's attachments) becomes the list of their ids", () => {
  const { paths, place } = callFiles(['a.pdf', 'b.png'])
  assert.deepEqual(paths, ['a.pdf', 'b.png'])
  assert.deepEqual(place(['att-1', 'att-2']), ['att-1', 'att-2'])
})

test('no files: nothing to upload', () => {
  assert.deepEqual(callFiles(undefined).paths, [])
  assert.deepEqual(callFiles([]).paths, [])
})

test('an operation with several files fields has each one uploaded; one of before, its one', () => {
  assert.deepEqual(filesFieldsOf({ filesField: 'a', filesFields: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(filesFieldsOf({ filesField: 'attachments' }), ['attachments'])
  assert.deepEqual(filesFieldsOf({}), [])
  assert.deepEqual(filesFieldsOf(undefined), [])
})

test("each field's paths are uploaded, in order, and replaced by their ids in the same shape", async () => {
  const uploaded: string[] = []
  const upload = async (path: string) => {
    uploaded.push(path)
    return `id:${path}`
  }
  const input = {
    model: 'm',
    first_frame_image_path: 'frames/first.png',
    reference_image_paths: ['a.png', 'b.png'],
  }
  const sent = await withUploads(
    input,
    ['first_frame_image_path', 'last_frame_image_path', 'reference_image_paths'],
    upload,
  )
  assert.deepEqual(sent, {
    model: 'm',
    first_frame_image_path: 'id:frames/first.png',
    reference_image_paths: ['id:a.png', 'id:b.png'],
  })
  assert.deepEqual(uploaded, ['frames/first.png', 'a.png', 'b.png'])
  // The teammate's input is left as it was.
  assert.equal(input.first_frame_image_path, 'frames/first.png')
})

test('a call without files goes as it is; a field listing something else than paths is refused', async () => {
  const upload = async () => assert.fail('nothing to upload')
  const input = { model: 'm' }
  assert.equal(await withUploads(input, ['audio_path'], upload), input)
  assert.equal(await withUploads(null, ['audio_path'], upload), null)
  await assert.rejects(
    withUploads({ attachments: [3] }, ['attachments'], async () => 'x'),
    /attachments lists file paths/,
  )
})
