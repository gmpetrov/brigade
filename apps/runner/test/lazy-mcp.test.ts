import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The browser relay as the harness runs it (an MCP server on stdio), in front of a stand-in for
// Playwright's MCP server: started at the thread's first browser tool call, not at each turn's
// start (about 130 MB a turn), with its handshake answered from an earlier turn until then.

const runnerDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELAY = join(runnerDir, 'src', 'browser-relay.ts')

/** Like Playwright's: one tool listed, and a call first asks the harness for its roots. */
const FAKE_SERVER = `import { appendFileSync } from 'node:fs'
const log = (entry) => appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(entry) + '\\n')
log({ started: process.argv.slice(2) })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let buffer = ''
let call
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const m = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    log({ got: m })
    if (m.method === 'initialize')
      send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-browser', version: '1' } } })
    else if (m.method === 'tools/list')
      send({ id: m.id, result: { tools: [{ name: 'browser_navigate', description: 'Go to a page', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }] } })
    else if (m.method === 'tools/call') {
      call = m
      send({ id: 'roots-1', method: 'roots/list' })
    } else if (m.id === 'roots-1')
      send({ id: call.id, result: { content: [{ type: 'text', text: call.params.name + ' in ' + m.result.roots[0].uri }] } })
    else if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
process.stdin.on('end', () => process.exit(0))
`

const HANDSHAKE = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: {} },
  clientInfo: { name: 'claude-code', version: '2.1.316' },
}

type Message = {
  id?: string | number
  method?: string
  params?: any
  result?: any
  error?: { message?: string }
}

async function setUp() {
  const home = await mkdtemp(join(tmpdir(), 'lazy-mcp-'))
  const server = join(home, 'fake-server.mjs')
  await writeFile(server, FAKE_SERVER)
  await mkdir(join(home, '.browser-tabs'))
  const log = join(home, 'server.log')
  const entries = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { started?: string[]; got?: Message })
  const kept = join(home, '.browser-tabs', '.mcp')
  /** The relays started, stopped at the end even when the test fails. */
  const relays: ChildProcess[] = []
  const cleanUp = async () => {
    for (const relay of relays) relay.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
  return { home, server, log, entries, kept, relays, cleanUp }
}

/** What did not come stops the test, rather than waiting for ever. */
function within<T>(promise: Promise<T>, what: string, ms = 10_000) {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** One turn's connection: the harness's side of the relay. */
function turn(setup: Awaited<ReturnType<typeof setUp>>, env: Record<string, string> = {}) {
  const relay = spawn(
    process.execPath,
    ['--import', 'tsx', RELAY, '1', join(setup.home, '.browser-tabs', 'thread.json'), setup.server],
    {
      cwd: runnerDir,
      env: { ...process.env, HOME: setup.home, FAKE_MCP_LOG: setup.log, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  setup.relays.push(relay)
  const received: Message[] = []
  const waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = []
  let buffer = ''
  relay.stdout.setEncoding('utf8')
  relay.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)) as Message
      buffer = buffer.slice(end + 1)
      received.push(message)
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(message)) waiter.resolve(message)
        else waiters.push(waiter)
      }
    }
  })
  const exited = new Promise<number | null>((resolve) => relay.on('close', resolve))
  const next = (match: (m: Message) => boolean) =>
    within(
      new Promise<Message>((resolve) => {
        const found = received.find(match)
        if (found) resolve(found)
        else waiters.push({ match, resolve })
      }),
      'message',
    )
  const send = (message: Message) =>
    relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  return {
    received,
    send,
    next,
    request: async (id: number, method: string, params: unknown = {}) => {
      send({ id, method, params })
      return next((m) => m.id === id && !m.method)
    },
    /** Whether the relay runs a server now (a process of its own). */
    serving: () => {
      try {
        return (
          execFileSync('pgrep', ['-P', String(relay.pid)])
            .toString()
            .trim() !== ''
        )
      } catch {
        return false
      }
    },
    end: async () => {
      relay.stdin.end()
      return within(exited, 'exit')
    },
  }
}

async function handshake(t: ReturnType<typeof turn>, params: unknown = HANDSHAKE) {
  const initialize = await t.request(1, 'initialize', params)
  t.send({ method: 'notifications/initialized' })
  const list = await t.request(2, 'tools/list')
  return { initialize, list }
}

function waitFor<T>(check: () => Promise<T | undefined>): Promise<T> {
  let stop = false
  const poll = async () => {
    for (; !stop; await new Promise((resolve) => setTimeout(resolve, 20))) {
      const value = await check()
      if (value !== undefined) return value
    }
    throw new Error('stopped')
  }
  return within(poll(), 'expected state').finally(() => (stop = true))
}

const keptFile = async (kept: string) => {
  const names = (await readdir(kept).catch(() => [])).filter((name) => name.endsWith('.json'))
  return names.length === 1 ? join(kept, names[0]!) : undefined
}

test(
  "a first turn's handshake goes to the server, started at once, and its answers are kept",
  { timeout: 30_000 },
  async () => {
    const setup = await setUp()
    try {
      const first = turn(setup)
      const { initialize, list } = await handshake(first)
      assert.equal(initialize.result.serverInfo.name, 'fake-browser')
      assert.equal(list.result.tools[0].name, 'browser_navigate')
      assert.equal(first.serving(), true)
      const file = await waitFor(() => keptFile(setup.kept))
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        initialize: initialize.result,
        tools: list.result,
      })
      assert.equal(await first.end(), 0)
    } finally {
      await setup.cleanUp()
    }
  },
)

test(
  "a later turn is answered by the relay until a tool call starts the server with the harness's handshake",
  { timeout: 30_000 },
  async () => {
    const setup = await setUp()
    try {
      const first = turn(setup)
      const before = await handshake(first)
      await waitFor(() => keptFile(setup.kept))
      assert.equal(await first.end(), 0)

      const later = turn(setup)
      const { initialize, list } = await handshake(later)
      assert.deepEqual(initialize.result, before.initialize.result)
      assert.deepEqual(list.result, before.list.result)
      assert.deepEqual((await later.request(3, 'ping')).result, {})
      // Nothing started for it: the server of the first turn is the only one so far.
      assert.equal(later.serving(), false)
      assert.equal((await setup.entries()).filter((entry) => entry.started).length, 1)

      // A tool call: the server starts, gets the harness's handshake, then the call. Its own
      // requests reach the harness, and the harness's answers reach it.
      later.send({
        id: 4,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: {} },
      })
      const roots = await later.next((m) => m.method === 'roots/list')
      later.send({ id: roots.id, result: { roots: [{ uri: 'file:///work' }] } })
      const call = await later.next((m) => m.id === 4)
      assert.deepEqual(call.result, {
        content: [{ type: 'text', text: 'browser_navigate in file:///work' }],
      })
      assert.equal(later.serving(), true)
      // From now on everything goes to the server.
      await later.request(5, 'tools/list')
      const entries = await setup.entries()
      const second = entries.slice(entries.findLastIndex((entry) => entry.started))
      assert.deepEqual(
        second.slice(1).map((entry) => [entry.got?.id, entry.got?.method]),
        [
          ['brigade-relay-initialize', 'initialize'],
          [undefined, 'notifications/initialized'],
          [4, 'tools/call'],
          ['roots-1', undefined],
          [5, 'tools/list'],
        ],
      )
      assert.deepEqual(second[1]!.got!.params, HANDSHAKE)
      // The relay's own handshake was answered by the server, and went no further.
      assert.ok(later.received.every((m) => m.id !== 'brigade-relay-initialize'))
      assert.equal(later.received.filter((m) => m.id === 1).length, 1)
      assert.equal(await later.end(), 0)
    } finally {
      await setup.cleanUp()
    }
  },
)

test(
  'a turn that never calls a tool leaves without starting the server',
  { timeout: 30_000 },
  async () => {
    const setup = await setUp()
    try {
      const first = turn(setup)
      await handshake(first)
      await waitFor(() => keptFile(setup.kept))
      await first.end()
      const later = turn(setup)
      await handshake(later)
      assert.equal(await later.end(), 0)
      assert.equal((await setup.entries()).filter((entry) => entry.started).length, 1)
    } finally {
      await setup.cleanUp()
    }
  },
)

test(
  'another handshake, a broken file or a request the relay does not answer start the server at once',
  { timeout: 30_000 },
  async () => {
    const setup = await setUp()
    const started = async () => (await setup.entries()).filter((entry) => entry.started).length
    try {
      const first = turn(setup)
      await handshake(first)
      const file = await waitFor(() => keptFile(setup.kept))
      await first.end()

      // Another client version: its answers may differ, so the server gives them.
      const other = turn(setup)
      await handshake(other, { ...HANDSHAKE, protocolVersion: '2025-03-26' })
      assert.equal(other.serving(), true)
      await other.end()
      assert.equal(await started(), 2)

      // A request the relay has no answer for, before any tool call: the server's own answer.
      const asking = turn(setup)
      await handshake(asking)
      assert.equal(asking.serving(), false)
      const resources = await asking.request(3, 'resources/list')
      assert.equal(resources.error?.message, 'Method not found')
      await asking.end()
      assert.equal(await started(), 3)

      // A broken file: the server answers, and the file is written again.
      await writeFile(file, '{"initialize":')
      const broken = turn(setup)
      const { list } = await handshake(broken)
      assert.equal(broken.serving(), true)
      await waitFor(async () =>
        (await readFile(file, 'utf8').catch(() => '')).startsWith('{"initialize":{')
          ? true
          : undefined,
      )
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tools, list.result)
      await broken.end()
      assert.equal(await started(), 4)
      assert.ok(existsSync(file))
    } finally {
      await setup.cleanUp()
    }
  },
)

test(
  "the server's settings are part of what its answers are kept for, and a config file keeps none",
  { timeout: 30_000 },
  async () => {
    const setup = await setUp()
    const started = async () => (await setup.entries()).filter((entry) => entry.started).length
    try {
      const first = turn(setup)
      await handshake(first)
      await waitFor(() => keptFile(setup.kept))
      await first.end()

      // Other settings (more tools): the server answers, started at once.
      const caps = turn(setup, { PLAYWRIGHT_MCP_CAPS: 'pdf' })
      await handshake(caps)
      assert.equal(caps.serving(), true)
      await caps.end()
      assert.equal(await started(), 2)
      // And the next turn with the same settings is answered from what that one kept.
      await waitFor(async () =>
        (await readdir(setup.kept)).filter((name) => name.endsWith('.json')).length === 2
          ? true
          : undefined,
      )
      const again = turn(setup, { PLAYWRIGHT_MCP_CAPS: 'pdf' })
      await handshake(again)
      assert.equal(again.serving(), false)
      await again.end()
      assert.equal(await started(), 2)

      // A config file can change under the same name: nothing is kept, the server answers.
      const config = join(setup.home, 'playwright.json')
      await writeFile(config, '{}')
      for (const round of [1, 2]) {
        const configured = turn(setup, { PLAYWRIGHT_MCP_CONFIG: config })
        await handshake(configured)
        assert.equal(configured.serving(), true, `round ${round}`)
        await configured.end()
      }
      assert.equal(await started(), 4)
      assert.equal((await readdir(setup.kept)).filter((name) => name.endsWith('.json')).length, 2)
    } finally {
      await setup.cleanUp()
    }
  },
)
