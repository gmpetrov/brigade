// A file a teammate sends to an MCP App goes as a link to the bucket, never through the API
// (src/file-links.ts): the tool's address fields get a path field of Brigade's beside them, and
// the call's uploads' ids become signed links in the address fields before the App gets it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileFields, linkFiles, withFiles } from '../src/file-links.js'

// OpenRouter's tools as its server lists them (Nov 6), trimmed to the fields that matter here.
const transcribe = {
  type: 'object',
  properties: {
    audio_base64: {
      type: 'string',
      description: 'Base64-encoded audio bytes, for small clips only.',
    },
    audio_url: { type: 'string', description: 'HTTPS URL of the audio file to transcribe.' },
    format: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['model'],
}
const image = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    prompt: { type: 'string' },
    reference_image_urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reference images (https or data URLs) for image-to-image.',
    },
  },
  required: ['model', 'prompt'],
}
const video = {
  type: 'object',
  properties: {
    first_frame_image_url: {
      type: 'string',
      description: 'Image the video starts from (https or data URL).',
    },
    last_frame_image_url: { type: 'string', description: 'Image the video ends on.' },
    model: { type: 'string' },
  },
}

test("a tool that takes a file's address beside the file gets a path field for it", () => {
  const spec = withFiles(transcribe)
  assert.equal(spec.filesField, 'audio_path')
  assert.deepEqual(spec.filesFields, ['audio_path'])
  const properties = spec.inputSchema.properties as Record<
    string,
    { type: string; description: string }
  >
  assert.equal(properties.audio_path?.type, 'string')
  assert.match(properties.audio_path!.description, /audio_url/)
  assert.match(properties.audio_path!.description, /rather than typing a file into audio_base64/)
  // The tool's own fields and what it requires stay as they were.
  assert.deepEqual(Object.keys(properties).sort(), [
    'audio_base64',
    'audio_path',
    'audio_url',
    'format',
    'model',
  ])
  assert.deepEqual(spec.inputSchema.required, ['model'])
})

test('a list of addresses that takes data URLs gets a list of paths; a field named for a file, a path', () => {
  assert.deepEqual(fileFields(image), [
    {
      path: 'reference_image_paths',
      url: 'reference_image_urls',
      many: true,
      inline: 'a data URL',
    },
  ])
  assert.deepEqual(fileFields(video), [
    {
      path: 'first_frame_image_path',
      url: 'first_frame_image_url',
      many: false,
      inline: 'a data URL',
    },
    { path: 'last_frame_image_path', url: 'last_frame_image_url', many: false },
  ])
  const spec = withFiles(video)
  assert.deepEqual(spec.filesFields, ['first_frame_image_path', 'last_frame_image_path'])
  // An old runner reads only filesField: the first one.
  assert.equal(spec.filesField, 'first_frame_image_path')
})

test('other addresses, and tools that already have the field, stay as they are', () => {
  const others = {
    type: 'object',
    properties: {
      webhook_url: { type: 'string', description: 'Where to POST the result' },
      profile_url: { type: 'string' },
      site_urls: { type: 'array', items: { type: 'string' } },
      // An address that is not a string is not one Brigade fills.
      audio_url: { type: 'object' },
      audio_base64: { type: 'string' },
    },
  }
  assert.deepEqual(fileFields(others), [])
  assert.deepEqual(withFiles(others), { inputSchema: others })
  const taken = {
    type: 'object',
    properties: { ...transcribe.properties, audio_path: { type: 'string' } },
  }
  assert.deepEqual(fileFields(taken), [])
  assert.deepEqual(fileFields({ type: 'object' }), [])
})

const link = async (id: string) => `https://bucket.example/${id}?X-Amz-Signature=s`

test('the uploaded file becomes a link in the field it fills, and the path field goes', async () => {
  const input = { model: 'openai/whisper-large-v3-turbo', audio_path: 'att-1', format: 'ogg' }
  assert.deepEqual(await linkFiles(input, fileFields(transcribe), link), {
    model: 'openai/whisper-large-v3-turbo',
    format: 'ogg',
    audio_url: 'https://bucket.example/att-1?X-Amz-Signature=s',
  })
  // The call's own input is left as it was (an approval keeps it).
  assert.equal(input.audio_path, 'att-1')
})

test('files for a list go after the addresses it has, in their order', async () => {
  const linked = await linkFiles(
    {
      model: 'm',
      prompt: 'p',
      reference_image_urls: ['https://example.com/a.png'],
      reference_image_paths: ['att-2', 'att-3'],
    },
    fileFields(image),
    link,
  )
  assert.deepEqual(linked.reference_image_urls, [
    'https://example.com/a.png',
    'https://bucket.example/att-2?X-Amz-Signature=s',
    'https://bucket.example/att-3?X-Amz-Signature=s',
  ])
  assert.ok(!('reference_image_paths' in linked))
})

test('a call without a file is passed on as it is; a wrong one is refused before the App', async () => {
  const input = { model: 'm', audio_url: 'https://example.com/a.ogg' }
  assert.equal(await linkFiles(input, fileFields(transcribe), link), input)
  const fields = fileFields(transcribe)
  await assert.rejects(
    linkFiles({ audio_url: 'https://example.com/a.ogg', audio_path: 'att-1' }, fields, link),
    /Give audio_url or audio_path, not both/,
  )
  await assert.rejects(linkFiles({ audio_path: ['att-1'] }, fields, link), /audio_path is the path/)
  await assert.rejects(
    linkFiles({ reference_image_paths: 'att-1' }, fileFields(image), link),
    /lists files/,
  )
  // A file the thread has not uploaded (a path an older runner left as it was) is the link's to refuse.
  await assert.rejects(
    linkFiles({ audio_path: 'work/a.ogg' }, fields, async (id) => {
      throw new Error(`No file ${id} to send from this thread`)
    }),
    /No file work\/a\.ogg to send from this thread/,
  )
})
