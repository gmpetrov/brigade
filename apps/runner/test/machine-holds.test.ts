import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MachineHolds } from '../src/machine-holds.js'

// Who uses a thread's machine (machine-holds.ts): its preview and the commands run there.
// - the preview going to sleep does not stop the machine while a command runs there;
// - after the last command, the machine stays up a while for the next one, then stops;
// - a command that comes within that while keeps it up;
// - a sleep decided before an up reaches the API before it, never after;
// - an up that gets no machine holds nothing, and stops nothing;
// - a release this runner knew nothing of (it started since) still stops the machine.

const machine = { id: 'm', host: 'h', port: 22, user: 'u', hostKey: 'k', size: 'test' }

function api(options: { slowSleep?: Promise<void>; none?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    up: async (sessionId: string) => {
      calls.push(`up ${sessionId}`)
      return options.none ? { machine: null, reason: 'none here' } : { machine }
    },
    sleep: async (sessionId: string) => {
      calls.push(`sleep ${sessionId} started`)
      await options.slowSleep
      calls.push(`sleep ${sessionId}`)
    },
    touch: async (sessionId: string) => void calls.push(`touch ${sessionId}`),
  }
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('the preview going to sleep leaves the machine up while a command runs there', async () => {
  const calls = api()
  const holds = new MachineHolds(calls)
  await holds.up('t', 'preview', 'key')
  await holds.up('t', 'run:a', 'key')
  await holds.release('t', 'preview')
  assert.deepEqual(calls.calls, ['up t', 'up t'], 'not stopped: the command holds it')
  await holds.release('t', 'run:a', 50)
  assert.deepEqual(calls.calls, ['up t', 'up t'], 'kept a while for the next command')
  await wait(120)
  assert.deepEqual(calls.calls, ['up t', 'up t', 'sleep t started', 'sleep t'])
  assert.deepEqual(holds.holders('t'), [])
})

test('a command within the while after the last keeps the machine up', async () => {
  const calls = api()
  const holds = new MachineHolds(calls)
  await holds.up('t', 'run:a', 'key')
  await holds.release('t', 'run:a', 60)
  await wait(20)
  await holds.up('t', 'run:b', 'key')
  await wait(100)
  assert.ok(!calls.calls.some((c) => c.startsWith('sleep')), 'not stopped under the next command')
  await holds.release('t', 'run:b', 0)
  assert.ok(calls.calls.includes('sleep t'), 'stopped once that one is done too')
})

test('a sleep under way reaches the API before an up that came after it', async () => {
  let release!: () => void
  const slowSleep = new Promise<void>((done) => (release = done))
  const calls = api({ slowSleep })
  const holds = new MachineHolds(calls)
  await holds.up('t', 'preview', 'key')
  const sleeping = holds.release('t', 'preview')
  await wait(10)
  assert.deepEqual(calls.calls, ['up t', 'sleep t started'])
  const up = holds.up('t', 'run:a', 'key')
  await wait(20)
  assert.deepEqual(calls.calls, ['up t', 'sleep t started'], 'the up waits for the sleep')
  release()
  await Promise.all([sleeping, up])
  assert.deepEqual(calls.calls, ['up t', 'sleep t started', 'sleep t', 'up t'])
  assert.deepEqual(holds.holders('t'), ['run:a'])
})

test('a sleep not under way yet is not made once someone comes for the machine', async () => {
  let release!: () => void
  const slowUp = new Promise<void>((done) => (release = done))
  const calls = api()
  const holds = new MachineHolds({
    ...calls,
    up: async (sessionId) => {
      await slowUp
      return calls.up(sessionId)
    },
  })
  const first = holds.up('t', 'preview', 'key')
  // The preview gives it back while its own up is still under way, then a command comes.
  const sleeping = holds.release('t', 'preview')
  const second = holds.up('t', 'run:a', 'key')
  release()
  await Promise.all([first, sleeping, second])
  assert.deepEqual(calls.calls, ['up t', 'up t'], 'never stopped under the command')
  assert.deepEqual(holds.holders('t'), ['run:a'])
})

test('an up that gets no machine holds nothing, and stops nothing', async () => {
  const calls = api({ none: true })
  const holds = new MachineHolds(calls)
  const answer = await holds.up('t', 'run:a', 'key')
  assert.equal(answer.machine, null)
  assert.deepEqual(holds.holders('t'), [])
  await wait(20)
  assert.deepEqual(calls.calls, ['up t'], 'no sleep for a machine it never had')
})

test('a release this runner knew nothing of still stops the machine', async () => {
  const calls = api()
  const holds = new MachineHolds(calls)
  await holds.release('t', 'preview')
  assert.deepEqual(calls.calls, ['sleep t started', 'sleep t'])
})
