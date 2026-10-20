import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { STORED_IMAGE } from '@brigade/contracts'

// bucket.ts reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = await mkdtemp(join(tmpdir(), 'event-images-'))
const { imageIn, keepImagesApart } = await import('../src/event-images.js')
const { listObjects, putObject, threadImageKey, threadImagesPrefix } =
  await import('../src/bucket.js')

const scope = { organizationId: 'org1', workspaceId: 'ws1' }

/** Bytes that start like a PNG, as many as a small screenshot. */
const png = (fill = 1) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(6000, fill),
  ])
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6000, 2)])
const nameOf = (bytes: Buffer, ext: string) =>
  `${createHash('sha256').update(bytes).digest('hex')}.${ext}`

/** A put that records what it was given instead of storing it. */
function recorder() {
  const puts: { key: string; size: number; type: string }[] = []
  const put = async (key: string, body: Uint8Array, type: string) => {
    puts.push({ key, size: body.length, type })
  }
  return { puts, put }
}

test('an image is found in base64 or in a data: URL, by its bytes', () => {
  assert.equal(imageIn(png().toString('base64'))?.name, nameOf(png(), 'png'))
  const found = imageIn(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  assert.equal(found?.name, nameOf(jpeg, 'jpg'))
  assert.equal(found?.type, 'image/jpeg')
  assert.deepEqual(Buffer.from(found!.bytes), jpeg)
})

test('long base64 that is not an image, short images and text are left alone', () => {
  // A thinking block's signature: base64, but no image.
  assert.equal(imageIn(Buffer.alloc(6000, 7).toString('base64')), undefined)
  assert.equal(imageIn(png().subarray(0, 100).toString('base64')), undefined)
  assert.equal(imageIn(`${png().toString('base64')} and some words`), undefined)
  assert.equal(imageIn('x'.repeat(10_000)), undefined)
})

test("a Read tool's image and the harness's copy of it become one object", async () => {
  const data = png().toString('base64')
  const name = nameOf(png(), 'png')
  const read = {
    type: 'tool.finished',
    toolName: 'read',
    output: { type: 'image', file: { type: 'image/png', base64: data, originalSize: 6008 } },
  }
  const raw = {
    type: 'raw',
    source: 'harness',
    value: {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
          },
        ],
      },
    },
  }
  const { puts, put } = recorder()
  const event = await keepImagesApart(scope, 's1', { read, raw }, put)
  assert.equal(event.read.output.file.base64, `${STORED_IMAGE}${name}`)
  assert.equal(event.read.output.file.type, 'image/png', 'what is around the image stays')
  assert.equal(
    (event.raw.value.message.content[0]!.content[0]!.source as { data: string }).data,
    `${STORED_IMAGE}${name}`,
  )
  assert.deepEqual(puts, [
    { key: threadImageKey(scope, 's1', name), size: 6008, type: 'image/png' },
  ])
})

test('an event with no image is the same value, and nothing is put', async () => {
  const { puts, put } = recorder()
  const event = { type: 'tool.finished', output: { stdout: 'x'.repeat(10_000) } }
  assert.equal(await keepImagesApart(scope, 's1', event, put), event)
  assert.equal(puts.length, 0)
})

test('when the bucket refuses an image, the event keeps it inline', async () => {
  const event = { output: [png(3).toString('base64'), jpeg.toString('base64')] }
  const failing = async () => {
    throw new Error('bucket put failed: 503')
  }
  assert.equal(await keepImagesApart(scope, 's1', event, failing), event)
})

test("a thread's images are listed by its folder, for deleting them with it", async () => {
  const names = [nameOf(png(4), 'png'), nameOf(jpeg, 'jpg')]
  for (const name of names) await putObject(threadImageKey(scope, 's2', name), png(4), 'image/png')
  await putObject(threadImageKey(scope, 's3', names[0]!), png(4), 'image/png')
  const listed = await listObjects(threadImagesPrefix(scope, 's2'))
  assert.deepEqual(listed.sort(), names.map((n) => threadImageKey(scope, 's2', n)).sort())
  assert.deepEqual(await listObjects(threadImagesPrefix(scope, 'none')), [])
})

test('a stored image key takes only a hash and an image extension', () => {
  assert.throws(() => threadImageKey(scope, 's1', '../x.png'))
  assert.throws(() => threadImageKey(scope, 's1', `${'a'.repeat(64)}.svg`))
  assert.throws(() => threadImageKey(scope, '../s1', `${'a'.repeat(64)}.png`))
})
