import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  STORED_FILE,
  THREAD_FILE_MAX,
  type AgentEvent,
  type RunnerToApi,
  type SequencedEvent,
} from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-event-files-'))
process.env.BRIGADE_HOME = home
const { EventFiles, fileIn, hasFile, tooLargeNote } = await import('../src/event-files.js')
const { Outbox } = await import('../src/outbox.js')
const { Connection } = await import('../src/connection.js')
const { UploadError } = await import('../src/uploads.js')

after(() => rm(home, { recursive: true, force: true }))

/** A PNG of about `size` bytes: its signature, then noise. */
const png = (size = 6000) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size)])
const nameOf = (bytes: Buffer, ext: string) =>
  `${createHash('sha256').update(bytes).digest('hex')}.${ext}`

const shot = (data: string): AgentEvent =>
  ({
    at: new Date().toISOString(),
    type: 'tool.result',
    toolCallId: 'c1',
    output: { content: [{ type: 'image', data, mimeType: 'image/png' }] },
  }) as unknown as AgentEvent
const text = (value: string): AgentEvent => ({
  at: new Date().toISOString(),
  type: 'raw',
  source: 'runner',
  value,
})

test('images and PDFs are found by their first bytes, in base64 or data: URLs; other text is not', () => {
  const image = png()
  const found = fileIn(image.toString('base64'))
  assert.ok(found && 'name' in found)
  assert.equal(found.name, nameOf(image, 'png'))
  assert.equal(found.type, 'image/png')
  assert.ok(found.bytes.equals(image))

  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5000)])
  const fromUrl = fileIn(`data:application/pdf;base64,${pdf.toString('base64')}`)
  assert.ok(fromUrl && 'name' in fromUrl)
  assert.equal(fromUrl.name, nameOf(pdf, 'pdf'))

  // Too short to be worth it, plain text, base64 of something else, a PNG head then not base64.
  assert.equal(fileIn(png(100).toString('base64')), undefined)
  assert.equal(fileIn('x'.repeat(10_000)), undefined)
  assert.equal(fileIn(randomBytes(6000).fill(1, 0, 8).toString('base64')), undefined)
  assert.equal(
    fileIn(`${image.toString('base64').slice(0, 100)} and then prose ${'y'.repeat(5000)}`),
    undefined,
  )
  // Nor an SVG: it can run script.
  assert.equal(
    fileIn(
      `data:image/svg+xml;base64,${Buffer.from(`<svg>${'a'.repeat(5000)}</svg>`).toString('base64')}`,
    ),
    undefined,
  )

  assert.equal(hasFile({ a: [1, { b: image.toString('base64') }] }), true)
  assert.equal(hasFile({ a: ['x'.repeat(10_000)] }), false)
})

test('a file over the limit becomes a short note, never decoded', () => {
  const head = png(10).toString('base64').slice(0, 16)
  const huge = head + 'A'.repeat(Math.ceil((THREAD_FILE_MAX * 4) / 3))
  const found = fileIn(huge)
  assert.ok(found && 'tooLarge' in found)
  assert.equal(tooLargeNote(found.tooLarge), '[file too large to keep: 33 MB]')
})

/** A fake outbox and a store that records each upload. */
function setup(fail?: (name: string, call: number) => Error | undefined) {
  const stored: string[] = []
  const replaced: SequencedEvent[][] = []
  const dropped: string[] = []
  const sent: SequencedEvent[][] = []
  let calls = 0
  const files = new EventFiles({
    store: async (sessionId, name) => {
      const error = fail?.(name, ++calls)
      if (error) throw error
      stored.push(`${sessionId}/${name}`)
    },
    outbox: {
      replace: (_sessionId, events) => replaced.push(events),
      drop: (sessionId) => dropped.push(sessionId),
    },
  })
  return { files, stored, replaced, dropped, sent, send: (e: SequencedEvent[]) => sent.push(e) }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await sleep(5)
  assert.ok(check(), 'in time')
}

test('events with files wait for their upload, the same file once; the others go at once', async () => {
  const image = png()
  const base64 = image.toString('base64')
  const name = nameOf(image, 'png')
  const s = setup()
  const events: SequencedEvent[] = [
    { sessionId: 'a', seq: 1, event: text('hello') },
    { sessionId: 'a', seq: 2, event: shot(base64) },
    { sessionId: 'a', seq: 3, event: shot(`data:image/png;base64,${base64}`) },
    { sessionId: 'b', seq: 1, event: text('other thread') },
  ]
  const now = s.files.take(events, s.send)
  assert.deepEqual(
    now.map((e) => `${e.sessionId}${e.seq}`),
    ['a1', 'b1'],
  )
  // Sent again while its files upload: not twice.
  assert.deepEqual(s.files.take(events.slice(1, 3), s.send), [])
  await until(() => s.sent.length === 1)
  assert.deepEqual(s.stored, [`a/${name}`])
  const [kept] = s.sent
  assert.deepEqual(
    kept!.map((e) => e.seq),
    [2, 3],
  )
  for (const e of kept!)
    assert.deepEqual((e.event as unknown as { output: unknown }).output, {
      content: [{ type: 'image', data: `${STORED_FILE}${name}`, mimeType: 'image/png' }],
    })
  assert.deepEqual(s.replaced, s.sent, 'the outbox keeps them without the bytes')

  // A later event with it again: known to be there, not uploaded again.
  s.files.take([{ sessionId: 'a', seq: 4, event: shot(base64) }], s.send)
  await until(() => s.sent.length === 2)
  assert.deepEqual(s.stored, [`a/${name}`])
})

test('a failed upload leaves the events queued as they were; the next send tries again', async () => {
  const image = png()
  const s = setup((_name, call) =>
    call === 1 ? new UploadError('the bucket refused the upload (503)', 503) : undefined,
  )
  const event = { sessionId: 'a', seq: 1, event: shot(image.toString('base64')) }
  assert.deepEqual(s.files.take([event], s.send), [])
  await sleep(50)
  assert.deepEqual(s.sent, [])
  assert.deepEqual(s.replaced, [])
  assert.deepEqual(s.dropped, [])
  // Another thread is not held back meanwhile.
  assert.equal(s.files.take([{ sessionId: 'b', seq: 1, event: text('x') }], s.send).length, 1)
  s.files.take([event], s.send)
  await until(() => s.sent.length === 1)
  assert.deepEqual(s.stored, [`a/${nameOf(image, 'png')}`])
})

test('a deleted thread drops its events; a refused file becomes a note', async () => {
  const gone = setup(() => new UploadError('the API refused the file (410)', 410))
  gone.files.take([{ sessionId: 'a', seq: 1, event: shot(png().toString('base64')) }], gone.send)
  await until(() => gone.dropped.length === 1)
  assert.deepEqual(gone.dropped, ['a'])
  assert.deepEqual(gone.sent, [])

  const refused = setup(() => new UploadError('the API refused the file (400)', 400))
  refused.files.take(
    [{ sessionId: 'a', seq: 1, event: shot(png().toString('base64')) }],
    refused.send,
  )
  await until(() => refused.sent.length === 1)
  assert.deepEqual((refused.sent[0]![0]!.event as unknown as { output: unknown }).output, {
    content: [
      { type: 'image', data: '[file not kept: Brigade refused it]', mimeType: 'image/png' },
    ],
  })
})

test('the outbox keeps the rewritten event on disk, and forgets a deleted thread', async () => {
  const dir = join(home, 'outbox')
  const outbox = new Outbox(dir)
  const image = png()
  outbox.push('a', text('first'))
  const withFile = outbox.push('a', shot(image.toString('base64')))
  outbox.replace('a', [{ ...withFile, event: shot(`${STORED_FILE}x.png`) }])
  const disk = await readFile(join(dir, 'a.jsonl'), 'utf8')
  assert.ok(!disk.includes(image.toString('base64').slice(0, 100)))
  assert.ok(disk.includes(`${STORED_FILE}x.png`))
  assert.equal(new Outbox(dir).unacknowledged().length, 2)
  outbox.drop('a')
  assert.ok(outbox.settled('a'))
  assert.equal(new Outbox(dir).unacknowledged().length, 0)
})

test('the connection sends events with files only once they are uploaded', async () => {
  const outbox = new Outbox(join(home, 'outbox-connection'))
  const image = png()
  const stored: string[] = []
  const files = new EventFiles({
    store: async (_sessionId, name) => void stored.push(name),
    outbox,
  })
  const connection = new Connection(
    { apiUrl: 'http://127.0.0.1:9', token: 'test' } as never,
    outbox,
    () => undefined,
    async () => ({}),
    () => false,
    (events, send) => files.take(events, send),
  )
  const sent: RunnerToApi[] = []
  Object.assign(connection, { ready: true, send: (m: RunnerToApi) => sent.push(m) })
  connection.sendEvent(outbox.push('a', text('one')))
  connection.sendEvent(outbox.push('a', shot(image.toString('base64'))))
  await until(() => sent.length === 2)
  const json = JSON.stringify(sent)
  assert.ok(!json.includes(image.toString('base64').slice(0, 100)), 'no bytes on the socket')
  assert.ok(json.includes(`${STORED_FILE}${nameOf(image, 'png')}`))
  assert.deepEqual(stored, [nameOf(image, 'png')])
  assert.ok(JSON.stringify(outbox.unacknowledged()).includes(STORED_FILE))
})
