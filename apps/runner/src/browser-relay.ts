// One thread's view of its teammate's browser. The harness's browser MCP
// server connects here instead of to Chrome; this relay passes the DevTools
// protocol through, but shows the thread only the tabs it opened itself (and
// their popups), so threads sharing the teammate's browser each have their own
// tabs. The harness restarts its MCP servers between turns, so a thread's tabs
// are remembered in a file and kept; tabs of threads idle for a day are closed.
//
// Usage (as the MCP server command): browser-relay <chrome-port> <tabs-file> <mcp-cli> [args...]
// Runs as the teammate's Linux user, the only user that can reach its browser.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

type Message = {
  id?: number
  method?: string
  params?: Record<string, any>
  result?: Record<string, any>
  error?: unknown
  sessionId?: string
}

const [chromePort, tabsFile, cli, ...cliArgs] = process.argv.slice(2)
if (!chromePort || !tabsFile || !cli) {
  console.error('usage: browser-relay <chrome-port> <tabs-file> <mcp-cli> [args...]')
  process.exit(2)
}
/** Tabs of threads idle this long are closed. */
const STALE_MS = 24 * 3600_000

const readTabs = (file: string): string[] => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as string[]
  } catch {
    return []
  }
}
const writeTabs = (tabs: Set<string>) => {
  mkdirSync(dirname(tabsFile!), { recursive: true, mode: 0o700 })
  writeFileSync(tabsFile!, JSON.stringify([...tabs]), { mode: 0o600 })
}

/** Relay messages of its own, kept apart from the client's ids. */
let ownId = 1_000_000_000

async function browserEndpoint() {
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/version`)
  return ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
}

function relay(client: WebSocket, upstream: WebSocket) {
  const owned = new Set(readTabs(tabsFile!)) // target ids this thread opened, across turns
  const sessions = new Set<string>() // protocol sessions attached to those targets
  const methods = new Map<number, string>() // client request id -> method
  let creating = 0 // createTarget requests in flight
  let held: Message[] = [] // upstream messages held until they can be attributed

  const add = owned.add.bind(owned)
  const remove = owned.delete.bind(owned)
  owned.add = (id) => (owned.has(id) ? owned : (add(id), writeTabs(owned), owned))
  owned.delete = (id) => remove(id) && (writeTabs(owned), true)
  writeTabs(owned) // also marks the thread as active

  const toUpstream = (m: Message) => upstream.send(JSON.stringify(m))
  const toClient = (m: Message) =>
    client.readyState === WebSocket.OPEN && client.send(JSON.stringify(m))
  const isOurs = (info: { targetId?: string; openerId?: string } | undefined) => {
    if (!info?.targetId) return false
    if (!owned.has(info.targetId) && info.openerId && owned.has(info.openerId))
      owned.add(info.targetId)
    return owned.has(info.targetId)
  }

  function fromUpstream(m: Message) {
    // Replies to the relay's own requests.
    if (m.id !== undefined && m.id >= 1_000_000_000) return
    // Replies to the client.
    if (m.id !== undefined) {
      const method = methods.get(m.id)
      methods.delete(m.id)
      if (method === 'Target.getTargets' && m.result?.targetInfos)
        m.result.targetInfos = m.result.targetInfos.filter(
          (t: { type: string; targetId: string; openerId?: string }) =>
            t.type === 'browser' || isOurs(t),
        )
      return toClient(m)
    }
    // Events inside a session: only sessions of this thread's targets.
    if (m.sessionId && !sessions.has(m.sessionId)) return
    const p = m.params ?? {}
    switch (m.method) {
      case 'Target.attachedToTarget':
        if (m.sessionId || isOurs(p.targetInfo)) {
          sessions.add(p.sessionId)
          return toClient(m)
        }
        // Another thread's tab, auto-attached to this connection: let it run, and let go of it.
        toUpstream({
          id: ownId++,
          method: 'Runtime.runIfWaitingForDebugger',
          sessionId: p.sessionId,
        })
        toUpstream({
          id: ownId++,
          method: 'Target.detachFromTarget',
          params: { sessionId: p.sessionId },
        })
        return
      case 'Target.detachedFromTarget':
        if (!sessions.delete(p.sessionId)) return
        return toClient(m)
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
      case 'Target.targetCrashed':
        return isOurs(p.targetInfo ?? p) ? toClient(m) : undefined
      case 'Target.targetDestroyed':
        if (!owned.delete(p.targetId)) return
        return toClient(m)
      default:
        return toClient(m)
    }
  }

  upstream.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Message
    const isCreateReply = m.id !== undefined && methods.get(m.id) === 'Target.createTarget'
    // A new tab's events arrive before the reply naming it: hold everything
    // meanwhile, then pass it on in the original order once the tab is known.
    if (isCreateReply) {
      creating--
      if (m.result?.targetId) owned.add(m.result.targetId)
    }
    if (creating > 0 || held.length > 0) held.push(m)
    else fromUpstream(m)
    if (creating === 0 && held.length > 0) {
      const queue = held
      held = []
      queue.forEach(fromUpstream)
    }
  })

  const onClientMessage = (raw: Buffer) => {
    const m = JSON.parse(String(raw)) as Message
    const deny = (message: string) =>
      toClient({
        id: m.id,
        error: { code: -32000, message },
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      })
    if (m.sessionId && !sessions.has(m.sessionId)) return deny('No such session')
    const target = m.params?.targetId as string | undefined
    if (
      target &&
      m.method?.startsWith('Target.') &&
      m.method !== 'Target.createTarget' &&
      !owned.has(target)
    )
      return deny('No such target')
    if (m.id !== undefined && m.method) methods.set(m.id, m.method)
    if (m.method === 'Target.createTarget') creating++
    toUpstream(m)
  }
  client.on('message', onClientMessage)

  // The thread's tabs stay open for its next turn.
  client.on('close', () => upstream.close())
  upstream.on('close', () => client.close())
  client.on('error', () => client.close())
  upstream.on('error', () => client.close())
  return onClientMessage
}

/** Close the tabs of this teammate's threads that have been idle for a day. */
async function closeStaleTabs() {
  const dir = dirname(tabsFile!)
  const stale = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((file) => file !== tabsFile && file.endsWith('.json'))
    .filter((file) => Date.now() - statSync(file).mtimeMs > STALE_MS)
  if (stale.length === 0) return
  const upstream = new WebSocket(await browserEndpoint())
  await new Promise((resolve, reject) => upstream.once('open', resolve).once('error', reject))
  for (const file of stale) {
    for (const targetId of readTabs(file))
      upstream.send(
        JSON.stringify({ id: ownId++, method: 'Target.closeTarget', params: { targetId } }),
      )
    rmSync(file, { force: true })
  }
  setTimeout(() => upstream.close(), 500)
}

async function main() {
  void closeStaleTabs().catch(() => undefined)
  const token = randomBytes(24).toString('hex')
  // Another local user could reach this port; the random path keeps them out.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: `/${token}` })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (client) => {
    // The client speaks first; keep what it says until the browser connection is open.
    const early: Buffer[] = []
    const keep = (raw: Buffer) => early.push(raw)
    client.on('message', keep)
    void browserEndpoint().then(
      (endpoint) => {
        const upstream = new WebSocket(endpoint)
        upstream.once('open', () => {
          client.off('message', keep)
          const onMessage = relay(client, upstream)
          early.forEach(onMessage)
        })
        upstream.once('error', () => client.close())
      },
      () => client.close(),
    )
  })
  const { port } = server.address() as { port: number }

  // The MCP server speaks to the harness on stdio, inherited as is.
  const child = spawn(
    process.execPath,
    [cli!, ...cliArgs, '--cdp-endpoint', `ws://127.0.0.1:${port}/${token}`],
    {
      stdio: 'inherit',
    },
  )
  child.on('exit', (code) => {
    server.close()
    process.exit(code ?? 0)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
}

void main()
