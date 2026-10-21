import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RestoreState } from '@brigade/providers'
import { restored, type RestoreWait } from '../src/cloud-restore.js'

/** A provider answering these in turn (an Error is thrown), on a clock each sleep moves on. */
function scripted(answers: (RestoreState | Error)[]) {
  let clock = 0
  let checks = 0
  const wait: RestoreWait = {
    everyMs: 15_000,
    forMs: 60_000,
    checkMs: 1_000,
    failures: 3,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  }
  const check = async () => {
    const answer = answers[Math.min(checks++, answers.length - 1)]!
    if (answer instanceof Error) throw answer
    return answer
  }
  return { check, wait, checks: () => checks }
}

const copying: RestoreState = { done: false, running: true }

test('a restore is waited for until it is done, and named', async () => {
  const { check, wait, checks } = scripted([
    copying,
    copying,
    { done: true, at: '2026-10-21T01:52:00.000Z' },
  ])
  assert.deepEqual(await restored(check, wait), { done: true, at: '2026-10-21T01:52:00.000Z' })
  assert.equal(checks(), 3)
})

test('a computer that stops while restoring is not waited for', async () => {
  const { check, wait } = scripted([copying, { done: false, running: false }])
  assert.deepEqual(await restored(check, wait), { done: false, why: 'stopped' })
})

test('a restore is waited for at most so long', async () => {
  const { check, wait, checks } = scripted([copying])
  assert.deepEqual(await restored(check, wait), { done: false, why: 'too long' })
  // At 0, 15, 30, 45 and 60 s.
  assert.equal(checks(), 5)
})

test('checks that fail now and then are tried again; failing in a row, the error is thrown', async () => {
  const blip = scripted([
    new Error('502'),
    copying,
    new Error('502'),
    new Error('502'),
    { done: true, at: '' },
  ])
  assert.deepEqual(await restored(blip.check, blip.wait), { done: true, at: '' })
  const down = scripted([copying, new Error('502')])
  await assert.rejects(restored(down.check, down.wait), /502/)
  assert.equal(down.checks(), 4)
})

test('a check that never answers fails, and does not outlast the wait', async () => {
  let checks = 0
  const hung = () => {
    checks++
    return new Promise<never>(() => {})
  }
  let clock = 0
  const fake = {
    sleep: async (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
  await assert.rejects(
    restored(hung, { everyMs: 15_000, forMs: 60_000, checkMs: 5, failures: 3, ...fake }),
    /no answer in 5 ms/,
  )
  assert.equal(checks, 3)
  // On a real clock, the one check left when the wait ends is given up with it.
  assert.deepEqual(await restored(hung, { everyMs: 5, forMs: 20, checkMs: 60_000, failures: 5 }), {
    done: false,
    why: 'too long',
  })
})
