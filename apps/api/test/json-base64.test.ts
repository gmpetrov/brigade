import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { jsonBase64Field } from '../src/json-base64.js'

/** The bytes the field decodes to, fed in pieces of `size` bytes. */
async function decode(json: string, size: number) {
  const bytes = new TextEncoder().encode(json)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size))
      controller.close()
    },
  })
  const out: number[] = []
  for await (const chunk of body.pipeThrough(
    jsonBase64Field('data'),
  ) as unknown as AsyncIterable<Uint8Array>)
    out.push(...chunk)
  return new Uint8Array(out)
}

test('a base64url field decodes as it arrives, however the answer is cut', async () => {
  for (const length of [0, 1, 2, 3, 4, 5, 100, 1001]) {
    const original = new Uint8Array(randomBytes(length))
    const data = Buffer.from(original).toString('base64url')
    // As Gmail answers: the size first, then the data, pretty-printed.
    const json = `{\n  "size": ${length},\n  "data": "${data}"\n}`
    for (const size of [1, 2, 3, 7, 64, json.length])
      assert.deepEqual(await decode(json, size), original, `${length} bytes in pieces of ${size}`)
  }
})

test('padded base64 decodes too, and the word as a value is not the field', async () => {
  const original = new Uint8Array(randomBytes(31))
  const json = `{"kind": "data", "data" : "${Buffer.from(original).toString('base64')}"}`
  assert.deepEqual(await decode(json, 5), original)
})

test('an answer without the field fails rather than giving nothing', async () => {
  await assert.rejects(decode('{"error": {"code": 404}}', 4), /No "data"/)
})
