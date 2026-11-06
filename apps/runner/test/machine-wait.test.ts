// A wait on the thread's machine ends when a message comes in (src/harness/arrivals.ts): the
// command goes on there, and the call says so, so the turn reads the message now rather than
// once the wait is over (10 minutes by default). Nov 6: a person's question waited minutes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Arrivals } from '../src/harness/arrivals.js'
import { machineTools, type MachineRunResult, type MachineRunTools } from '../src/harness/tools.js'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Until `ms` passed or the signal says to stop, as MachineRuns waits. */
function waitFor(ms: number, signal?: AbortSignal) {
  return new Promise<void>((done) => {
    if (signal?.aborted) return done()
    const timer = setTimeout(done, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })
}

/** A machine whose one command runs until `end()`. */
function machine() {
  const stopped: string[] = []
  let ended = false
  const view = (status: MachineRunResult['status']): MachineRunResult => ({
    id: 'r1',
    command: 'npx hyperframes render',
    cwd: 'video',
    status,
    startedAt: new Date().toISOString(),
    seconds: 1,
    notes: [],
  })
  const runs: MachineRunTools = {
    run: async (_input, waitMs, signal) => {
      await waitFor(waitMs, signal)
      return view(ended ? 'succeeded' : 'running')
    },
    get: async (_id, waitMs, _lines, signal) => {
      await waitFor(waitMs, signal)
      return view(ended ? 'succeeded' : 'running')
    },
    stop: async (id) => {
      stopped.push(id)
      return view('stopped')
    },
    list: () => [],
  }
  return { runs, stopped, end: () => void (ended = true) }
}

const credentials = { env: async () => ({ file: '' }) } as never

type Result = MachineRunResult & { note: string }

function tools(runs: MachineRunTools, arrivals?: Arrivals) {
  const all = machineTools(runs, credentials, arrivals)
  const call = (name: string, input: Record<string, unknown>) =>
    all[name]!.execute!(input as never, { toolCallId: 'c1', messages: [] }) as Promise<Result>
  return {
    run: (input: Record<string, unknown>) => call('run_on_machine', input),
    wait: (input: Record<string, unknown>) => call('machine_run', input),
  }
}

test('a message that comes in ends the wait of run_on_machine; the command goes on', { timeout: 10_000 }, async () => {
  const { runs, stopped } = machine()
  const arrivals = new Arrivals()
  const started = Date.now()
  const result = tools(runs, arrivals).run({ command: 'npx hyperframes render', cwd: 'video' })
  await sleep(50)
  arrivals.arrived()
  const ended = await result
  assert.ok(Date.now() - started < 5_000, 'not the 10 minutes of its wait')
  assert.equal(ended.status, 'running')
  assert.match(ended.note, /A message came in while you waited/)
  assert.match(ended.note, /machine_run\(\{ id: "r1" \}\)/)
  assert.deepEqual(stopped, [], 'the command is not stopped')
  assert.equal(arrivals.listening, 0)
})

test(
  'machine_run ends its wait for one too, and one that starts before the turn read it at once',
  { timeout: 10_000 },
  async () => {
  const { runs } = machine()
  const arrivals = new Arrivals()
  const waiting = tools(runs, arrivals).wait({ id: 'r1' })
  await sleep(50)
  arrivals.arrived()
  assert.match((await waiting).note, /A message came in/)
  // The model had not read it yet (no tool's result since): the next wait ends at once.
  const started = Date.now()
  const next = await tools(runs, arrivals).wait({ id: 'r1', waitMinutes: 10 })
  assert.ok(Date.now() - started < 1_000)
  assert.match(next.note, /A message came in/)
  // Read with that result: the wait after it waits.
  arrivals.read()
  const after = await tools(runs, arrivals).wait({ id: 'r1', waitMinutes: 0.002 })
  assert.match(after.note, /^Still running on the machine/)
  assert.equal(arrivals.listening, 0)
})

test('a command that ended as the message came says it is done, as ever', { timeout: 10_000 }, async () => {
  const { runs, end } = machine()
  const arrivals = new Arrivals()
  end()
  arrivals.arrived()
  const result = await tools(runs, arrivals).wait({ id: 'r1' })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.note, 'Done.')
})

test('without a message the wait lasts as long as it is asked, and a stop does not wait', { timeout: 10_000 }, async () => {
  const { runs, stopped } = machine()
  const arrivals = new Arrivals()
  const started = Date.now()
  const result = await tools(runs, arrivals).run({ command: 'x', cwd: 'video', waitMinutes: 0.005 })
  assert.ok(Date.now() - started >= 250, 'waited its 0.3 s')
  assert.match(result.note, /^Still running on the machine/)
  const stop = await tools(runs, arrivals).wait({ id: 'r1', stop: true })
  assert.equal(stop.status, 'stopped')
  assert.deepEqual(stopped, ['r1'])
})

test('a hand-over to the next runner ends the wait with its own note; one after it ends at once', { timeout: 10_000 }, async () => {
  const { runs, stopped } = machine()
  const arrivals = new Arrivals()
  const waiting = tools(runs, arrivals).run({ command: 'npx hyperframes render', cwd: 'video' })
  await sleep(50)
  arrivals.handOver()
  const ended = await waiting
  assert.equal(ended.status, 'running')
  assert.match(ended.note, /^Brigade's runner is updating, which ended this wait/)
  assert.match(ended.note, /\(id r1\)/)
  assert.match(ended.note, /machine_run\(\{ id: "r1" \}\)/)
  const started = Date.now()
  const next = await tools(runs, arrivals).wait({ id: 'r1', waitMinutes: 10 })
  assert.ok(Date.now() - started < 1_000)
  assert.match(next.note, /^Brigade's runner is updating/)
  assert.deepEqual(stopped, [])
  assert.equal(arrivals.listening, 0)
})
