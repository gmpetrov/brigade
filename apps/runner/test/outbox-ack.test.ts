import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The API acknowledges a thread's events up to the last it holds. A runner that took a thread in
// without its arrival numbered its events from its own count, below the API's, and the API
// dropped them: acknowledged, they go, and the thread's next events are numbered after the API's.
const home = await mkdtemp(join(tmpdir(), 'brigade-outbox-ack-'))
process.env.BRIGADE_HOME = home
const { Outbox } = await import('../src/outbox.js')

test.after(() => rm(home, { recursive: true, force: true }))

const event = { at: new Date().toISOString(), type: 'raw', source: 'runner', value: 'x' } as const

test("events numbered below the API's go once acknowledged, and the next come after its", () => {
  const dir = join(home, 'a')
  const outbox = new Outbox(dir)
  for (let i = 0; i < 3; i++) outbox.push('t', event)
  outbox.ack('t', 1925)
  assert.equal(outbox.settled('t'), true)
  assert.equal(outbox.push('t', event).seq, 1926)

  // Already acknowledged that far, with events below it pending: they go too.
  const again = new Outbox(join(home, 'b'))
  again.ack('u', 0)
  again.push('u', event)
  again.ack('u', 1)
  assert.equal(again.settled('u'), true)
  assert.equal(again.push('u', event).seq, 2)
  again.ack('u', 1)
  assert.equal(again.settled('u'), false, 'one after the acknowledged seq stays')

  // As read back after a restart.
  assert.equal(new Outbox(dir).push('t', event).seq, 1927)
})
