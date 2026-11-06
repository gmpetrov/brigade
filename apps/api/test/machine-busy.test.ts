import assert from 'node:assert/strict'
import { test } from 'node:test'

// A command running on a thread's machine of its own keeps its runner's computer up
// (src/hub/runner-messages.ts): the runner follows it there and brings its files back, so its busy
// touch marks the computer in use, as a running thread does, and its idle stop waits (src/cloud.ts).
// A preview's touch does not: a person viewing it keeps the computer up from the dashboard. No
// database: the machine's own handling of the touch fails quietly.
process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { PROTOCOL_VERSION } = await import('@brigade/contracts')
type HubHost = import('../src/hub/host.js').HubHost
type RunnerConn = import('../src/hub/host.js').RunnerConn
const { WorkspaceHub } = await import('../src/hub/workspace-hub.js')
const { onRunnerMessage } = await import('../src/hub/runner-messages.js')
const { inHub } = await import('../src/hub/context.js')

class Host implements HubHost {
  readonly hibernates = false
  schedule() {}
  cancel() {}
  load<T>(): T | undefined {
    return undefined
  }
  save() {}
  persist() {}
}

test("a command on a thread's machine keeps its runner's computer up; a preview's touch does not", async () => {
  const hub = new WorkspaceHub('ws', new Host())
  const conn: RunnerConn = {
    kind: 'runner',
    id: 'conn',
    runnerId: 'runner',
    computerId: 'computer',
    organizationId: 'org',
    workspaceId: 'ws',
    connectedAt: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    socket: { send() {}, close() {} },
    heardAt: Date.now(),
    queue: Promise.resolve(),
    retries: new Map(),
    warnedInline: false,
  }
  hub.runners.set(conn.computerId, conn)
  const touch = (busy: boolean) =>
    inHub(hub, () =>
      onRunnerMessage(
        hub,
        conn,
        JSON.stringify({
          type: 'preview.machine',
          callId: `call-${busy}`,
          sessionId: 'thread',
          action: 'touch',
          ...(busy ? { busy: true } : {}),
        }),
      ),
    )
  await touch(false)
  assert.equal(hub.lastActiveAt('computer'), undefined, 'a preview’s touch: not in use')
  const before = Date.now()
  await touch(true)
  assert.ok((hub.lastActiveAt('computer') ?? 0) >= before, 'a command’s touch: in use')
})
