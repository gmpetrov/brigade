import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { MachineHolds } from '../src/machine-holds.js'

// Who uses a thread's machine (machine-holds.ts): its preview and the commands run there.
// - the preview going to sleep does not stop the machine while a command runs there;
// - after the last command, the machine stays up a while for the next one, said to the API as it
//   begins, then stops;
// - a command that comes within that while keeps it up;
// - a sleep decided before an up reaches the API before it, never after;
// - an up that gets no machine holds nothing, and stops nothing;
// - a release this runner knew nothing of (it started since) still stops the machine;
// - a runner started again (an update) stops a machine left waiting after a command when it was
//   due to, and at once one whose time was up;
// - it never stops one that a preview it took up or a command it follows again holds, nor one a
//   command came for within the wait; and it stops nothing before it took up all it was left,
//   even when a preview it took up gives its machine back first;
// - a stop whose timer comes a moment before its time by the wall clock (Node's timers and
//   Date.now() disagree by a millisecond now and then) is made at its time, not dropped.
// The tests of a wait run on clocks of their own (clocks()): nothing hangs on how fast this
// computer is, nor on its two clocks.

const machine = { id: 'm', host: 'h', port: 22, user: 'u', hostKey: 'k', size: 'test' }

function api(options: { slowSleep?: Promise<void>; none?: boolean; gone?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    up: async (sessionId: string) => {
      calls.push(`up ${sessionId}`)
      return options.none ? { machine: null, reason: 'none here' } : { machine }
    },
    sleep: async (sessionId: string) => {
      // The runner's connection closed as it updated: the sleep never reaches the API.
      if (options.gone) throw new Error('Lost the connection to Brigade during this call')
      calls.push(`sleep ${sessionId} started`)
      await options.slowSleep
      calls.push(`sleep ${sessionId}`)
    },
    touch: async (sessionId: string) => void calls.push(`touch ${sessionId}`),
  }
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** What the calls under way started is done: the fake API answers without waiting. */
const flush = () => new Promise((done) => setImmediate(done))

/**
 * The runner's two clocks in the test's hands: Node's timers (setTimeout, mocked) and the wall
 * clock (Date.now), which MachineHolds keeps its keepUntil by.
 */
function clocks(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let wall = 1_000_000
  t.mock.method(Date, 'now', () => wall)
  return {
    /**
     * The timers' clock moves on by `ms`, running what is due by then, and the wall clock by
     * `wallMs` (by as much, unless said); then what they started is done.
     */
    async pass(ms: number, wallMs = ms) {
      wall += wallMs
      t.mock.timers.tick(ms)
      await flush()
    },
  }
}

const made: string[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** Where a runner keeps its threads' machines, as each runner on the computer finds it. */
function stateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'machine-holds-'))
  made.push(dir)
  return join(dir, 'machine-holds.json')
}

/** A runner that started with nothing to take up (or took it up): it stops machines at once. */
function settled(holds: MachineHolds) {
  holds.rearm()
  return holds
}

test('the preview going to sleep leaves the machine up while a command runs there', async (t) => {
  const clock = clocks(t)
  const calls = api()
  const holds = new MachineHolds(calls)
  await holds.up('t', 'preview', 'key')
  await holds.up('t', 'run:a', 'key')
  await holds.release('t', 'preview')
  assert.deepEqual(calls.calls, ['up t', 'up t'], 'not stopped: the command holds it')
  await holds.release('t', 'run:a', 50)
  assert.deepEqual(
    calls.calls,
    ['up t', 'up t', 'touch t'],
    'kept a while for the next command, said to the API as that begins',
  )
  await clock.pass(49)
  assert.deepEqual(calls.calls, ['up t', 'up t', 'touch t'], 'still kept')
  await clock.pass(1)
  assert.deepEqual(calls.calls, ['up t', 'up t', 'touch t', 'sleep t started', 'sleep t'])
  assert.deepEqual(holds.holders('t'), [])
})

test('a stop whose timer comes a moment early by the wall clock is made at its time', async (t) => {
  const clock = clocks(t)
  const calls = api()
  const holds = new MachineHolds(calls)
  await holds.up('t', 'run:a', 'key')
  await holds.release('t', 'run:a', 100)
  // Due by the timers' clock while the wall clock is a millisecond short of it.
  await clock.pass(100, 99)
  assert.deepEqual(calls.calls, ['up t', 'touch t'], 'not stopped before its time')
  await clock.pass(1)
  assert.deepEqual(
    calls.calls,
    ['up t', 'touch t', 'sleep t started', 'sleep t'],
    'stopped at its time, not left up',
  )
})

test('a command within the while after the last keeps the machine up', async (t) => {
  const clock = clocks(t)
  const calls = api()
  const holds = new MachineHolds(calls)
  await holds.up('t', 'run:a', 'key')
  await holds.release('t', 'run:a', 60)
  await clock.pass(20)
  await holds.up('t', 'run:b', 'key')
  await clock.pass(100)
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

test('a runner started again stops a machine left waiting after a command, when it was due', async (t) => {
  const clock = clocks(t)
  const file = stateFile()
  // The runner before: a command ended, its machine kept a while; then it updated, its timers
  // and its connection gone with it.
  const before = settled(new MachineHolds(api({ gone: true }), { stateFile: file }))
  await before.up('t', 'run:a', 'key')
  await before.release('t', 'run:a', 150)
  const calls = api()
  const next = new MachineHolds(calls, { stateFile: file })
  next.rearm()
  await clock.pass(149)
  assert.deepEqual(calls.calls, [], 'still kept for the next command')
  await clock.pass(1)
  assert.deepEqual(calls.calls, ['sleep t started', 'sleep t'], 'stopped once its while was over')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [], 'and forgotten')
})

test('a runner started again stops at once a machine whose time was up', async () => {
  const file = stateFile()
  // Its preview stopped as the runner updated, and the sleep was lost with the connection.
  const before = settled(new MachineHolds(api({ gone: true }), { stateFile: file }))
  await before.up('t', 'preview', 'key')
  await before.release('t', 'preview')
  const calls = api()
  const next = new MachineHolds(calls, { stateFile: file })
  await wait(20)
  assert.deepEqual(calls.calls, [], 'nothing stopped before it took up what it was left')
  next.rearm()
  await wait(20)
  assert.deepEqual(calls.calls, ['sleep t started', 'sleep t'])
})

test('a runner started again never stops a machine a preview or a command it took up holds', async (t) => {
  const clock = clocks(t)
  const file = stateFile()
  const before = settled(new MachineHolds(api({ gone: true }), { stateFile: file }))
  await before.up('p', 'preview', 'key')
  await before.up('c', 'run:a', 'key')
  // Its time up (its sleep lost with the connection).
  await before.up('w', 'run:b', 'key')
  await before.release('w', 'run:b')
  // Waiting after a command, a while left.
  await before.up('n', 'run:c', 'key')
  await before.release('n', 'run:c', 300)
  const calls = api()
  const next = new MachineHolds(calls, { stateFile: file })
  // The preview handed over is taken up, the command followed again: each holds its machine.
  await next.up('p', 'preview', 'key')
  await next.up('c', 'run:a', 'key')
  // A new command comes for the machine whose time was up, before the runner settled.
  await next.up('w', 'run:d', 'key')
  next.rearm()
  await clock.pass(50)
  // A command comes for the machine still kept, within its while.
  await next.up('n', 'run:e', 'key')
  await clock.pass(400)
  assert.deepEqual(calls.calls, ['up p', 'up c', 'up w', 'up n'], 'none stopped under them')
  await next.release('c', 'run:a')
  assert.deepEqual(calls.calls.slice(4), ['sleep c started', 'sleep c'], 'once given back, it is')
})

test('a runner started again stops nothing before it took up all it was left', async () => {
  const file = stateFile()
  // A preview and a command on the machine as the runner updates.
  const before = settled(new MachineHolds(api({ gone: true }), { stateFile: file }))
  await before.up('t', 'preview', 'key')
  await before.up('t', 'run:a', 'key')
  const calls = api()
  const next = new MachineHolds(calls, { stateFile: file })
  // The preview is taken up and goes to sleep before the command is followed again.
  await next.up('t', 'preview', 'key')
  await next.release('t', 'preview')
  await wait(20)
  assert.deepEqual(calls.calls, ['up t'], 'not stopped under the command not followed yet')
  await next.up('t', 'run:a', 'key')
  next.rearm()
  await wait(20)
  assert.deepEqual(calls.calls, ['up t', 'up t'], 'nor once it holds it')
  await next.release('t', 'run:a')
  assert.deepEqual(calls.calls, ['up t', 'up t', 'sleep t started', 'sleep t'])
})
