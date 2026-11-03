import assert from 'node:assert/strict'
import { test } from 'node:test'
import { turnWait } from '../lib/turn-wait'

const slot = { kind: 'slot', key: 'q1', at: 1, teammateId: 'riley', running: 4 } as const
const preparing = { kind: 'preparing', key: 'q2', at: 2, teammateId: 'riley' } as const

test('a turn waiting for a slot right after the message', () => {
  assert.equal(turnWait([{ kind: 'user' }, slot]), slot)
})

test('a resumed turn that had output before it waited', () => {
  const items = [{ kind: 'user' }, { kind: 'start' }, { kind: 'assistant' }, { kind: 'tool' }, slot]
  assert.equal(turnWait(items), slot)
})

test('a teammate waiting after another one replied', () => {
  const items = [{ kind: 'user' }, { kind: 'start' }, { kind: 'assistant' }, { kind: 'turn' }, slot]
  assert.equal(turnWait(items), slot)
})

test('the wait ends once its turn starts, ends or fails', () => {
  for (const kind of ['start', 'turn', 'error']) {
    assert.equal(turnWait([{ kind: 'user' }, slot, { kind }]), undefined)
    assert.equal(turnWait([{ kind: 'user' }, preparing, { kind }]), undefined)
  }
  assert.equal(turnWait([{ kind: 'user' }, { kind: 'start' }]), undefined)
})

test('a moved thread getting its files ready, after its slot, with nobody writing', () => {
  const items = [{ kind: 'assistant' }, { kind: 'turn' }, { kind: 'note' }, slot, preparing]
  assert.equal(turnWait(items), preparing)
})

test('files that could not be put back end the preparing, not a slot wait', () => {
  assert.equal(turnWait([preparing, { kind: 'note' }]), undefined)
  assert.equal(turnWait([slot, { kind: 'note' }]), slot)
})

test('files ready with no turn after them (a thread taken back that waits on a person)', () => {
  assert.equal(turnWait([preparing, { kind: 'prepared' }]), undefined)
  assert.equal(turnWait([slot, { kind: 'prepared' }]), slot)
})
