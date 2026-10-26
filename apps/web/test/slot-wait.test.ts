import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slotWait } from '../lib/slot-wait'

const slot = { kind: 'slot', key: 'q1', at: 1, teammateId: 'riley', running: 4 } as const

test('a turn waiting for a slot right after the message', () => {
  assert.equal(slotWait([{ kind: 'user' }, slot]), slot)
})

test('a resumed turn that had output before it waited', () => {
  const items = [{ kind: 'user' }, { kind: 'start' }, { kind: 'assistant' }, { kind: 'tool' }, slot]
  assert.equal(slotWait(items), slot)
})

test('a teammate waiting after another one replied', () => {
  const items = [{ kind: 'user' }, { kind: 'start' }, { kind: 'assistant' }, { kind: 'turn' }, slot]
  assert.equal(slotWait(items), slot)
})

test('the wait ends once its turn starts, ends or fails', () => {
  for (const kind of ['start', 'turn', 'error'])
    assert.equal(slotWait([{ kind: 'user' }, slot, { kind }]), undefined)
  assert.equal(slotWait([{ kind: 'user' }, { kind: 'start' }]), undefined)
})
