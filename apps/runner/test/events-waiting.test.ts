import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunnerToApi, SequencedEvent } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-waiting-'))
process.env.BRIGADE_HOME = home
const { Outbox } = await import('../src/outbox.js')
const { Connection, eventBatches } = await import('../src/connection.js')

test.after(() => rm(home, { recursive: true, force: true }))

const event = { at: new Date().toISOString(), type: 'raw', source: 'runner', value: 'x' } as const

/** A connection that is up, with what it sends kept instead. */
function connected(outbox: InstanceType<typeof Outbox>) {
  const connection = new Connection(
    { apiUrl: 'http://127.0.0.1:9', token: 'test' } as never,
    outbox,
    () => undefined,
    async () => ({}),
    () => false,
  )
  const sent: RunnerToApi[] = []
  Object.assign(connection, { ready: true, send: (m: RunnerToApi) => sent.push(m) })
  return {
    connection: connection as unknown as {
      sendEvent(e: SequencedEvent): void
      checkWaiting(now: number): void
    },
    sent,
  }
}

test('a thread waits from its oldest unacknowledged event, until the API has them all', () => {
  const outbox = new Outbox(join(home, 'outbox-1'))
  const before = Date.now()
  outbox.push('a', event)
  outbox.push('a', event)
  outbox.push('b', event)
  outbox.ack('b', 1)
  assert.deepEqual(outbox.waiting(60_000, before + 30_000), [])
  const [waiting, ...others] = outbox.waiting(60_000, before + 120_000)
  assert.equal(others.length, 0, 'b has nothing left to send')
  assert.equal(waiting!.sessionId, 'a')
  assert.deepEqual(
    waiting!.events.map((e) => e.seq),
    [1, 2],
  )
  assert.ok(waiting!.since >= before && waiting!.since <= Date.now())
  outbox.ack('a', 1)
  assert.deepEqual(
    outbox.waiting(60_000, before + 120_000)[0]!.events.map((e) => e.seq),
    [2],
  )
  outbox.ack('a', 2)
  assert.deepEqual(outbox.waiting(0, before + 120_000), [])
})

test('events read back after a restart wait from then', () => {
  const dir = join(home, 'outbox-2')
  new Outbox(dir).push('a', event)
  const read = Date.now()
  const [waiting] = new Outbox(dir).waiting(0, read + 1000)
  assert.ok(waiting!.since >= read)
})

test('unacknowledged events are sent again, and a thread that waits for minutes is reported once', () => {
  const outbox = new Outbox(join(home, 'outbox-3'))
  const { connection, sent } = connected(outbox)
  const t = Date.now()
  connection.sendEvent(outbox.push('a', event))
  assert.deepEqual(
    sent.map((m) => m.type),
    ['events'],
  )

  connection.checkWaiting(t + 10_000)
  assert.equal(sent.length, 1, 'not yet: the acknowledgment may be on its way')
  connection.checkWaiting(t + 31_000)
  assert.deepEqual(
    sent.map((m) => m.type),
    ['events', 'events'],
  )
  connection.checkWaiting(t + 40_000)
  assert.equal(sent.length, 2, 'not again so soon after')

  connection.checkWaiting(t + 181_000)
  const report = sent.at(-1)!
  assert.equal(report.type, 'events.waiting')
  assert.equal(report.type === 'events.waiting' && report.threads[0]!.sessionId, 'a')
  const count = sent.length
  connection.checkWaiting(t + 182_000)
  assert.equal(sent.length, count, 'the same list is not sent again')

  outbox.ack('a', 1)
  connection.checkWaiting(t + 240_000)
  assert.deepEqual(sent.at(-1), { type: 'events.waiting', threads: [] })
})

test('a thread waiting for over a day is no longer sent again but on reconnect', () => {
  const outbox = new Outbox(join(home, 'outbox-4'))
  const { connection, sent } = connected(outbox)
  const t = Date.now()
  outbox.push('gone', event)
  connection.checkWaiting(t + 25 * 60 * 60_000)
  assert.deepEqual(
    sent.map((m) => m.type),
    ['events.waiting'],
  )
})

test('a replay goes in batches small enough for the WebSocket, an image-sized event alone', () => {
  const at = new Date().toISOString()
  const image = (seq: number): SequencedEvent => ({
    sessionId: 's1',
    seq,
    event: {
      at,
      type: 'message.images',
      id: 'm1',
      images: { [`/tmp/${seq}.png`]: `data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}` },
    },
  })
  const small = (seq: number): SequencedEvent => ({ sessionId: 's1', seq, event })
  const sizes = (events: SequencedEvent[]) =>
    eventBatches(events).map((batch) => batch.map((e) => e.seq))
  // Three 5 MiB images: one with the small events before it, then one each.
  assert.deepEqual(sizes([small(1), image(2), image(3), image(4), small(5)]), [[1, 2], [3], [4, 5]])
  // Small events still go 200 at a time.
  const many = Array.from({ length: 450 }, (_, i) => small(i + 1))
  assert.deepEqual(
    eventBatches(many).map((b) => b.length),
    [200, 200, 50],
  )
  assert.deepEqual(eventBatches([]), [])
})
