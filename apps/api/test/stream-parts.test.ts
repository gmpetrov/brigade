import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { ATTACHMENT_MAX } from '@brigade/contracts'
import type { ConnectorContext, SentFile } from '../src/connectors/types.js'
import {
  base64Lines,
  base64LinesLength,
  partsLength,
  partsStream,
  sendParts,
} from '../src/stream-parts.js'

// Gmail's module reads the API's settings; nothing here reaches a database.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// Through the registry, as the API loads them (gmail.ts and index.ts import each other).
const { connectors } = await import('../src/connectors/index.js')
const gmail = connectors.gmail!
const googleDrive = connectors.google_drive!

// A file sent to an App streams from the bucket as the request goes, never held whole by the API
// (src/stream-parts.ts): an email of 10 attachments of 25 MB once had to fit in a hub object's
// memory, shared with other workspaces, and base64 made it larger still.

/** As gmail.ts wrapped a file's bytes before they streamed: the MIME it must still send. */
const wrapped = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString('base64')
    .replace(/.{76}(?=.)/g, '$&\r\n')

/** Bytes in chunks of random sizes, as the bucket hands them. */
function chunked(bytes: Uint8Array, opened?: { count: number; largest: number }) {
  let at = 0
  if (opened) opened.count++
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      const n = Math.min(bytes.length - at, 1 + Math.floor(Math.random() * 70_000))
      if (opened) opened.largest = Math.max(opened.largest, n)
      controller.enqueue(bytes.slice(at, at + n))
      at += n
    },
  })
}

const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

test('base64 in lines streams to exactly what the whole file made, at any size and split', async () => {
  for (const size of [0, 1, 2, 3, 56, 57, 58, 76, 114, 1000, 65_536, 1_048_577]) {
    const bytes = randomBytes(size)
    const streamed = await text(base64Lines(chunked(bytes)))
    assert.equal(streamed, wrapped(bytes), `size ${size}`)
    assert.equal(base64LinesLength(size), Buffer.byteLength(wrapped(bytes)), `length of ${size}`)
  }
})

test('parts stream as one body of the length they say, and a file of another size is refused', async () => {
  const file = randomBytes(10_000)
  const parts = [
    'héllo\r\n',
    { size: file.length, open: async () => chunked(file), base64: true },
    '',
    { size: file.length, open: async () => chunked(file) },
    'end',
  ]
  const body = Buffer.from(await new Response(partsStream(parts)).arrayBuffer())
  assert.equal(body.length, partsLength(parts))
  assert.equal(body.toString('latin1').slice(-3), 'end')
  const short = [{ size: 10, open: async () => chunked(randomBytes(9)) }]
  await assert.rejects(text(partsStream(short)), /shorter/)
  const long = [{ size: 10, open: async () => chunked(randomBytes(11)) }]
  await assert.rejects(text(partsStream(long)), /longer/)
})

test('a body refused for an expired token goes again with its files opened anew', async () => {
  const opened = { count: 0, largest: 0 }
  const file = randomBytes(5000)
  const bodies: string[] = []
  const fetch = async (_url: string, init?: RequestInit) => {
    bodies.push(await new Response(init!.body).text())
    return new Response(null, { status: bodies.length === 1 ? 401 : 200 })
  }
  const response = await sendParts(fetch, 'https://x.test', { method: 'POST', headers: {} }, [
    'a',
    { size: file.length, open: async () => chunked(file, opened) },
  ])
  assert.equal(response.status, 200)
  assert.equal(opened.count, 2)
  assert.equal(bodies[0], bodies[1])
})

/** A Gmail or Drive context whose files stream, counting how they are opened and read. */
function context(files: Record<string, Uint8Array>) {
  const opened = { count: 0, largest: 0 }
  const sent: { url: string; body: Buffer; type?: string; length?: string }[] = []
  const ctx = {
    callId: 'c1',
    fetch: async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      sent.push({
        url,
        body: Buffer.from(await new Response(init?.body).arrayBuffer()),
        type: headers['content-type'],
        length: headers['content-length'],
      })
      return Response.json({ id: 'm1', threadId: 't1', name: 'x' })
    },
    keepFile: async () => assert.fail('nothing kept'),
    openFile: async (id: string): Promise<SentFile> => ({
      name: `${id}.bin`,
      contentType: 'application/octet-stream',
      size: files[id]!.length,
      open: async () => chunked(files[id]!, opened),
    }),
  } as unknown as ConnectorContext
  return { ctx, opened, sent }
}

const send = (ctx: ConnectorContext, input: unknown) => {
  const operation = gmail.operations.gmail_send!
  return operation.run(ctx, operation.input.parse(input))
}

test('an email with attachments sends the same MIME as before, streamed from the bucket', async () => {
  const files = { a: randomBytes(300_000), b: randomBytes(1001) }
  const { ctx, opened, sent } = context(files)
  await send(ctx, { to: ['x@example.com'], subject: 'Hi', body: 'Body', attachments: ['a', 'b'] })
  assert.equal(sent.length, 1)
  const { url, body, type, length } = sent[0]!
  assert.match(url, /\/upload\/gmail\/v1\/users\/me\/messages\/send\?uploadType=multipart/)
  assert.equal(Number(length), body.length, 'sent with its length, not in chunks')
  const outer = /boundary=(\S+)/.exec(type!)![1]!
  const message = body
    .toString('latin1')
    .split(`--${outer}\r\nContent-Type: message/rfc822\r\n\r\n`)[1]!
    .slice(0, -`\r\n--${outer}--`.length)
  const inner = /boundary="([^"]+)"/.exec(message)![1]!
  const part = (name: string, bytes: Uint8Array) =>
    [
      `Content-Type: application/octet-stream; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"; filename*=UTF-8''${name}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapped(bytes),
    ].join('\r\n')
  const before = [
    'To: x@example.com',
    `Subject: =?UTF-8?B?${Buffer.from('Hi').toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${inner}"`,
    '',
    `--${inner}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\nBody`,
    `--${inner}\r\n${part('a.bin', files.a)}`,
    `--${inner}\r\n${part('b.bin', files.b)}`,
    `--${inner}--`,
    '',
  ].join('\r\n')
  assert.equal(message, before)
  assert.equal(opened.count, 2)
  assert.ok(opened.largest <= 70_000, 'read in the chunks the bucket gives, never whole')
})

test('attachments past the limit are refused before any is read', async () => {
  const big = Math.ceil(ATTACHMENT_MAX / 2) + 1
  const files = { a: new Uint8Array(0), b: new Uint8Array(0) }
  const { ctx, opened, sent } = context(files)
  const sized = {
    ...ctx,
    openFile: async (id: string) => ({ ...(await ctx.openFile(id)), size: big }),
  } as ConnectorContext
  await assert.rejects(
    send(sized, { to: ['x@example.com'], subject: 'Hi', body: 'B', attachments: ['a', 'b'] }),
    /25 MB/,
  )
  assert.equal(opened.count, 0)
  assert.equal(sent.length, 0)
})

test('a Drive upload streams the file from the bucket', async () => {
  const files = { f: randomBytes(200_000) }
  const { ctx, opened, sent } = context(files)
  const operation = googleDrive.operations.drive_upload_file!
  await operation.run(ctx, operation.input.parse({ file: 'f' }))
  const { body, length } = sent[0]!
  assert.equal(Number(length), body.length)
  assert.ok(body.includes(Buffer.from(files.f)))
  assert.equal(opened.count, 1)
})
