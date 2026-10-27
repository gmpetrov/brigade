import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// A hub that hibernates (src/hub-object.ts) wakes with its runners made again from what their
// sockets kept (wokenRunner): a runner silent since is forgotten at the next tick, whatever woke
// the hub, and one that kept talking is not. No database: the tick's lookups fail quietly.
process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { PROTOCOL_VERSION } = await import('@brigade/contracts')
const { wokenRunner } = await import('../src/hub/host.js')
type HubHost = import('../src/hub/host.js').HubHost
type RunnerConn = import('../src/hub/host.js').RunnerConn
type RunnerState = import('../src/hub/host.js').RunnerState
const { WorkspaceHub, SILENT_MS } = await import('../src/hub/workspace-hub.js')
const { onRunnerMessage, HEARD_KEEP_MS } = await import('../src/hub/runner-messages.js')
const { inHub } = await import('../src/hub/context.js')

/** What a socket keeps: its attachment, as the object serializes it. */
const kept = new Map<string, RunnerState>()
const answered = new Map<string, number>()
const closed: string[] = []

class SleepyHost implements HubHost {
  readonly hibernates = true
  schedule() {}
  cancel() {}
  load<T>(): T | undefined {
    return undefined
  }
  save() {}
  persist(conn: RunnerConn) {
    const { socket: _s, heardAt: _h, queue: _q, retries: _r, warnedInline: _w, ...state } = conn
    kept.set(conn.id, structuredClone(state))
  }
  heardAt(socket: object) {
    return answered.get((socket as { id: string }).id)
  }
}

const socket = (id: string) => ({
  id,
  send() {},
  close: () => void closed.push(id),
})

function connect(hub: InstanceType<typeof WorkspaceHub>, id: string) {
  const conn: RunnerConn = {
    kind: 'runner',
    id,
    runnerId: `runner-${id}`,
    computerId: `computer-${id}`,
    organizationId: 'org',
    workspaceId: 'ws',
    connectedAt: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    socket: socket(id),
    heardAt: Date.now(),
    queue: Promise.resolve(),
    retries: new Map(),
    warnedInline: false,
  }
  hub.host.persist(conn)
  hub.runners.set(conn.computerId, conn)
  return conn
}

/** The hub after it hibernated: a new one, with its runners made again from their sockets. */
function wake() {
  const hub = new WorkspaceHub('ws', new SleepyHost())
  for (const state of kept.values()) {
    const conn = wokenRunner(state, socket(state.id))
    hub.runners.set(conn.computerId, conn)
  }
  return hub
}

test('a runner silent across a hibernation is forgotten at the tick that wakes the hub', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  try {
    kept.clear()
    answered.clear()
    closed.length = 0
    const before = new WorkspaceHub('ws', new SleepyHost())
    connect(before, 'silent')
    const talking = connect(before, 'talking')
    const keepingAlive = connect(before, 'keepalive')
    mock.timers.tick(60_000)
    // A message while awake, past the keeping interval: kept with its socket.
    await inHub(before, () => onRunnerMessage(before, talking, '{"type":"heartbeat"}'))
    assert.ok(HEARD_KEEP_MS < SILENT_MS)
    // The runtime answered keepalives without waking the hub.
    mock.timers.tick(60_000)
    answered.set('keepalive', Date.now())
    // The alarm wakes it: nothing the runners said.
    const hub = wake()
    await inHub(hub, () => hub.tick(Date.now()))
    assert.deepEqual(closed, ['silent'])
    assert.ok(!hub.runners.has('computer-silent'))
    assert.ok(hub.runners.has('computer-talking'))
    assert.ok(hub.runners.has('computer-keepalive'))
  } finally {
    mock.timers.reset()
  }
})

test("a hub object's threads waiting reach the checks without waking it, and are forgotten unless renewed", async () => {
  const { noteReportedWaiting, threadsWaitingEverywhere, REPORT_FRESH_MS } =
    await import('../src/ops/checks.js')
  class ReportingHost extends SleepyHost {
    reportWaiting(waiting: { sessionId: string; computerId: string; since: string }[]) {
      noteReportedWaiting('ws-object', waiting)
    }
  }
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 })
  try {
    const hub = new WorkspaceHub('ws-object', new ReportingHost())
    const since = new Date(Date.now() - 60_000).toISOString()
    hub.setEventsWaiting('laptop', new Map([['thread-1', since]]), new Set(['thread-1']))
    assert.deepEqual(threadsWaitingEverywhere(), [
      { sessionId: 'thread-1', computerId: 'laptop', since },
    ])
    // Through: the runner lists it no more, and the hub says so.
    hub.setEventsWaiting('laptop', new Map(), new Set())
    assert.deepEqual(threadsWaitingEverywhere(), [])
    // A report its hub stopped renewing (it went, with its runners) is forgotten.
    hub.setEventsWaiting('laptop', new Map([['thread-1', since]]), new Set(['thread-1']))
    mock.timers.tick(REPORT_FRESH_MS)
    assert.deepEqual(threadsWaitingEverywhere(), [])
  } finally {
    mock.timers.reset()
  }
})
