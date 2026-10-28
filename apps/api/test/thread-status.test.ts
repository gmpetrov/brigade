import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'

// A thread's status from its events (statusAfter): what a takeover and its hand back leave.
process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { statusAfter } = await import('../src/hub/thread-events.js')

const at = new Date().toISOString()
const control = (controller: 'human' | 'teammate', waiting?: boolean): AgentEvent => ({
  at,
  type: 'control.changed',
  controller,
  memberId: 'm1',
  ...(waiting ? { waiting } : {}),
})
const note = (waiting?: boolean): AgentEvent => ({
  at,
  type: 'message.user',
  text: 'A person took over this thread and has now handed it back to you.',
  memberId: 'm1',
  ...(waiting ? { waiting } : {}),
})
const fold = (events: AgentEvent[], from: Parameters<typeof statusAfter>[0]) =>
  events.reduce(statusAfter, from)

test('a hand back while the teammate still waits on its ticket leaves it waiting', () => {
  assert.equal(
    fold([control('human'), control('teammate', true), note(true)], 'waiting'),
    'waiting',
  )
})

test('a hand back once it waits on nobody leaves it idle', () => {
  assert.equal(fold([control('human'), control('teammate')], 'idle'), 'idle')
})

test('a hand back before the turn ends leaves it running', () => {
  assert.equal(fold([control('teammate')], 'running'), 'running')
})

test("a person's message still starts a turn", () => {
  assert.equal(fold([note()], 'idle'), 'running')
})
