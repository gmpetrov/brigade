// Run code that belongs to a workspace's hub (src/hub/) as the hub runs it: tests that call such
// a function directly, rather than through hubs.get(), run it here. Imported once the test has
// set the environment the API reads.

/** Run `fn` in the workspace's hub, in this process. */
export async function inWorkspaceHub<T>(workspaceId: string, fn: () => T): Promise<Awaited<T>> {
  const { localHub } = await import('../src/hub/memory-host.js')
  const { inHub } = await import('../src/hub/context.js')
  return inHub(localHub(workspaceId), async () => await fn())
}

type Sent = { type: string; callId?: string; ticketId?: string; [key: string]: unknown }

/**
 * A runner's connection for a computer of the workspace, as its hub knows it after a hello: what
 * is sent on it, and how a call it makes waits on it (live). Its calls run in the hub (run).
 */
export async function fakeRunner(
  scope: { organizationId: string; workspaceId: string },
  computerId: string,
) {
  const { localHub } = await import('../src/hub/memory-host.js')
  const { inHub } = await import('../src/hub/context.js')
  const { PROTOCOL_VERSION } = await import('@brigade/contracts')
  const { randomUUID } = await import('node:crypto')
  const hub = localHub(scope.workspaceId)
  const sent: Sent[] = []
  const conn = {
    kind: 'runner' as const,
    id: randomUUID(),
    runnerId: `runner-${computerId}`,
    computerId,
    ...scope,
    connectedAt: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    socket: { send: (text: string) => void sent.push(JSON.parse(text)), close: () => {} },
    heardAt: Date.now(),
    queue: Promise.resolve(),
    retries: new Map(),
    warnedInline: false,
  }
  hub.runners.set(computerId, conn)
  return {
    sent,
    live: { computerId, connectionId: conn.id },
    /** The handler's own answers, as sent on the connection. */
    reply: (message: object) => void sent.push(structuredClone(message) as Sent),
    run: <T>(fn: () => T) => inHub(hub, fn),
    close: () => {
      if (hub.runners.get(computerId) === conn) hub.runners.delete(computerId)
    },
  }
}
