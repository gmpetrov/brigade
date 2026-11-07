import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOAT_COMMAND_GRACE_MS,
  BOAT_REQUEST_MS,
  boatClient,
  boatDeadlineMs,
  createBoatLedger,
  createBoatMachines,
  createBoatProvider,
} from '../src/boat/index.js'
import { VM_PRICES, vmCost } from '../src/boat/prices.js'
import { DesktopNotReady } from '../src/types.js'

// Each request to boat has a deadline (src/boat/index.ts): one boat never answered held the
// API's jobs' queue for 10 minutes.
const base = 'https://boat.dev/api/v1/sandboxes/sb1'

test('a request has a deadline; a command as long as it may run; a stream none', () => {
  assert.equal(boatDeadlineMs(base, { method: 'GET' }), BOAT_REQUEST_MS)
  assert.equal(
    boatDeadlineMs(base, { method: 'PATCH', body: '{"ttlSeconds":3600}' }),
    BOAT_REQUEST_MS,
  )
  assert.equal(
    boatDeadlineMs(`${base}/commands`, {
      method: 'POST',
      body: '{"command":"ls","timeoutSeconds":600}',
    }),
    600_000 + BOAT_COMMAND_GRACE_MS,
  )
  assert.equal(
    boatDeadlineMs(`${base}/commands`, { method: 'POST', body: '{"command":"ls"}' }),
    30_000 + BOAT_COMMAND_GRACE_MS,
  )
  assert.equal(boatDeadlineMs(`${base}/commands/p1/stream`, { method: 'GET' }), null)
  assert.equal(boatDeadlineMs(`${base}/commands/p1`, { method: 'GET' }), BOAT_REQUEST_MS)
})

test('the client sends each request with its deadline, and keeps the caller’s own signal', async () => {
  const seen: (AbortSignal | null | undefined)[] = []
  const send = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init?.signal)
    return new Response(JSON.stringify({ sandbox: { id: 'sb1', state: 'ready' } }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const client = boatClient('key', 'https://boat.test/api/v1', send)
  await client.get({ sandboxId: 'sb1' })
  const mine = new AbortController()
  await client.get({ sandboxId: 'sb1' }, { signal: mine.signal })
  assert.ok(seen[0] instanceof AbortSignal && !seen[0].aborted)
  assert.ok(seen[1] instanceof AbortSignal && seen[1] !== mine.signal)
  mine.abort()
  assert.ok(seen[1]!.aborted, 'the caller’s abort still reaches the request')
})

/** A boat whose desktop answers `answers` in turn (the last one again after), counting the asks. */
function boatWithDesktop(answers: object[]) {
  let asked = 0
  const send = (async (url: string | URL | Request) => {
    assert.match(String(url), /\/sandboxes\/sb1\/desktop\?vnc=1$/)
    const answer = answers[Math.min(asked++, answers.length - 1)]
    return new Response(JSON.stringify({ ok: true, type: 'desktop', ...answer }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const provider = createBoatProvider({
    apiKey: 'key',
    basePath: 'https://boat.test/api/v1',
    send,
    desktopWait: { forMs: 50, everyMs: 5 },
  })
  return { provider, asked: () => asked }
}

const ref = { provider: 'boat', id: 'sb1' }

test('the desktop opens once boat has set it up', async () => {
  const { provider, asked } = boatWithDesktop([
    { provisioning: true },
    { provisioning: true, desktopUrl: 'https://vnc.test/?password=p' },
    { desktopUrl: 'https://vnc.test/?password=p' },
  ])
  assert.equal(await provider.desktopUrl(ref), 'https://vnc.test/?password=p')
  assert.equal(asked(), 3)
})

// On Nov 4, boat kept a running computer's desktop provisioning past the SDK's 5-minute wait:
// each request for it was held 5 minutes, then failed. Now the wait is short, and says "not ready".
test('a desktop boat is still setting up is not ready after a short wait, not a failure', async () => {
  const { provider, asked } = boatWithDesktop([{ provisioning: true }])
  const started = Date.now()
  await assert.rejects(provider.desktopUrl(ref), DesktopNotReady)
  assert.ok(Date.now() - started < 1000)
  assert.ok(asked() > 1, 'it asked again while waiting')
})

/** A boat answering each request from `answer`, keeping what it was asked. */
function boatAnswering(answer: (method: string, path: string, body: unknown) => object) {
  const asked: { method: string; path: string; body: unknown; headers: Headers }[] = []
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    asked.push({ method, path, body, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify(answer(method, path, body)), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const machines = createBoatMachines({
    apiKey: 'key',
    basePath: 'https://boat.test/api/v1',
    autoStopSeconds: 7200,
    send,
  })
  return { machines, asked }
}

// Preview machines (docs/previews.md): made with none of Brigade's boat secrets, boat's own stop
// as a backstop, and a key that makes a retry give the same machine; SSH where boat says.
test('a preview machine is made large, without secrets, under its key, and named', async () => {
  const { machines, asked } = boatAnswering((method, path) =>
    method === 'POST' && path === '/sandboxes'
      ? { sandbox: { id: 'sb9', state: 'provisioning' } }
      : { sandbox: { id: 'sb9', state: 'ready' } },
  )
  const calls: string[] = []
  const ref = await machines.create({
    name: 'brigade-preview-row1',
    key: 'brigade-preview-row1-0',
    onCreated: (made) => {
      calls.push(`created ${made.id} after ${asked.length} requests`)
    },
  })
  assert.deepEqual(ref, { provider: 'boat', id: 'sb9' })
  // Told as soon as boat has it, before it is named or waited for: it bills from then.
  assert.deepEqual(calls, ['created sb9 after 1 requests'])
  const made = asked.find((a) => a.method === 'POST' && a.path === '/sandboxes')!
  assert.deepEqual(made.body, { type: 'large', noEnv: true, ttlSeconds: 7200 })
  assert.equal(made.headers.get('idempotency-key'), 'brigade-preview-row1-0')
  assert.equal(made.headers.get('authorization'), 'Bearer key', 'its own headers are kept')
  const named = asked.find((a) => a.method === 'PATCH')!
  assert.equal(named.path, '/sandboxes/sb9')
  assert.deepEqual(named.body, { name: 'brigade-preview-row1' })
  assert.equal(machines.size, '8 vCPU, 16 GB')
})

test('a key is let into a preview machine, reached where boat says', async () => {
  const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey'
  const behindEndpoint = boatAnswering(() => ({
    machineIp: '2001:db8::2d',
    sshEndpoint: '147.135.131.27:19045',
    sshUser: 'user',
    hostKey: `${hostKey}\n`,
  }))
  const ref = { provider: 'boat', id: 'sb9' }
  assert.deepEqual(await behindEndpoint.machines.authorize(ref, 'ssh-ed25519 AAAAkey runner'), {
    host: '147.135.131.27',
    port: 19045,
    user: 'user',
    hostKey,
  })
  const sent = behindEndpoint.asked[0]!
  assert.equal(sent.path, '/sandboxes/sb9/sshkey')
  assert.deepEqual(sent.body, { key: 'ssh-ed25519 AAAAkey runner' })

  // Its own public address: port 22.
  const direct = boatAnswering(() => ({ machineIp: '51.91.2.48', hostKey }))
  assert.deepEqual(await direct.machines.authorize(ref, 'ssh-ed25519 AAAAkey'), {
    host: '51.91.2.48',
    port: 22,
    user: 'user',
    hostKey,
  })

  // No host key to pin: not connected to blindly.
  const unpinned = boatAnswering(() => ({ machineIp: '51.91.2.48' }))
  await assert.rejects(unpinned.machines.authorize(ref, 'ssh-ed25519 AAAAkey'), /no host key/)
})

// What VMs cost (docs/vm-costs.md): a start says when it resumed; boat's own figures are read.
test('a start says when boat resumed the VM, or that it was up already', async () => {
  const answering = (state: string) => {
    let resumed = false
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (init?.method === 'POST' && path.endsWith('/resume')) resumed = true
      const now = resumed ? 'ready' : state
      return new Response(JSON.stringify({ sandbox: { id: 'sb1', state: now } }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return createBoatProvider({ apiKey: 'key', basePath: 'https://boat.test/api/v1', send })
  }
  const before = Date.now()
  const stopped = await answering('archived').start({ provider: 'boat', id: 'sb1' })
  assert.ok(stopped && stopped.resumedAt && stopped.resumedAt.getTime() >= before)
  assert.deepEqual(await answering('ready').start({ provider: 'boat', id: 'sb1' }), {
    resumedAt: null,
  })
})

// On Nov 7, boat took about 15 minutes to archive a VM whose agent no longer answered: a start
// meanwhile waits for it, then resumes, rather than failing after 4 minutes.
test('a start waits for a stop still archiving, then resumes', async () => {
  const sandboxAfter = (archivingFor: number) => {
    let asks = 0
    const calls: string[] = []
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      calls.push(`${init?.method ?? 'GET'} ${path.replace('/api/v1', '')}`)
      let state = ++asks <= archivingFor ? 'archiving' : 'archived'
      if (calls.some((c) => c.endsWith('/resume'))) state = 'ready'
      return new Response(JSON.stringify({ sandbox: { id: 'sb1', state } }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const provider = createBoatProvider({
      apiKey: 'key',
      basePath: 'https://boat.test/api/v1',
      send,
      archivingWait: { forMs: 50, everyMs: 5 },
    })
    return { provider, calls }
  }
  // Archiving for 5 asks (25 ms): waited for, then resumed.
  const slow = sandboxAfter(5)
  const started = await slow.provider.start({ provider: 'boat', id: 'sb1' })
  assert.ok(started.resumedAt)
  assert.ok(slow.calls.includes('POST /sandboxes/sb1/resume'))
  // Archiving past the wait: a failure that says so, and no resume.
  const stuck = sandboxAfter(1000)
  await assert.rejects(stuck.provider.start({ provider: 'boat', id: 'sb1' }), /still archiving/)
  assert.ok(!stuck.calls.includes('POST /sandboxes/sb1/resume'))
})

/** A boat that answers each request with `answer(method, path)`, recording what it was asked. */
function boatReplying(answer: (method: string, path: string) => { status?: number; body: object }) {
  const asked: { method: string; path: string; body: unknown }[] = []
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname.replace('/api/v1', '')
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined
    asked.push({ method, path, body })
    const { status = 200, body: reply } = answer(method, path)
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return {
    asked,
    provider: createBoatProvider({ apiKey: 'key', basePath: 'https://boat.test/api/v1', send }),
  }
}

// boat's 409 answers, as a throwaway sandbox gave them on Nov 7.
const refusal = (code: string) => ({
  status: 409,
  body: { ok: false, type: 'sandbox.error', status: 409, code, message: code, error: { code } },
})

test('a recover says whether boat power-cycles the machine, reaches it, or cannot', async () => {
  const ref = { provider: 'boat', id: 'sb1' }
  const answers: [ReturnType<typeof refusal> | { body: object }, string][] = [
    [{ body: { ok: true, type: 'sandbox.recovering', status: 'recovering' } }, 'recovering'],
    [refusal('sandbox_is_reachable'), 'reachable'],
    [refusal('too_soon'), 'recovering'],
    [refusal('recover_unsupported'), 'impossible'],
    [refusal('no_machine'), 'impossible'],
    [refusal('reset_failed'), 'impossible'],
  ]
  for (const [reply, expected] of answers) {
    const { provider, asked } = boatReplying(() => reply)
    assert.equal(await provider.recover!(ref), expected)
    assert.deepEqual(
      asked.map((a) => `${a.method} ${a.path}`),
      ['POST /sandboxes/sb1/recover'],
    )
  }
  // A refusal Brigade does not know, or any other failure, is a failure.
  await assert.rejects(boatReplying(() => refusal('something_new')).provider.recover!(ref))
  await assert.rejects(
    boatReplying(() => ({ status: 500, body: { ok: false } })).provider.recover!(ref),
  )
})

test('a forced stop says so to boat; a stop does not', async () => {
  const ref = { provider: 'boat', id: 'sb1' }
  const { provider, asked } = boatReplying(() => ({
    status: 202,
    body: { ok: true, type: 'sandbox.stopping', id: 'sb1', status: 'archiving' },
  }))
  await provider.stop(ref)
  await provider.stop(ref, { force: true })
  assert.deepEqual(
    asked.map((a) => [`${a.method} ${a.path}`, a.body]),
    [
      ['POST /sandboxes/sb1/stop', undefined],
      ['POST /sandboxes/sb1/stop', { force: true }],
    ],
  )
})

test('what boat last saved: its last check of the disk, else its last snapshot', async () => {
  const ref = { provider: 'boat', id: 'sb1' }
  const sandbox = (fields: object) => () => ({
    body: { ok: true, type: 'sandbox.info', sandbox: { id: 'sb1', state: 'idle', ...fields } },
  })
  const checked = await boatReplying(
    sandbox({
      snapshotCompletedAt: '2026-11-06T23:01:11.196Z',
      snapshotVerifiedAt: '2026-11-06T23:05:00.000Z',
      health: 'degraded',
      healthReason: 'the tunnel does not answer',
    }),
  ).provider.saved!(ref)
  assert.equal(checked.savedAt?.toISOString(), '2026-11-06T23:05:00.000Z')
  assert.equal(checked.snapshotAt?.toISOString(), '2026-11-06T23:01:11.196Z')
  assert.equal(checked.health, 'degraded')
  assert.equal(checked.healthReason, 'the tunnel does not answer')
  const snapshotOnly = await boatReplying(
    sandbox({ snapshotCompletedAt: '2026-11-06T23:01:11.196Z', health: 'ok' }),
  ).provider.saved!(ref)
  assert.equal(snapshotOnly.savedAt?.toISOString(), '2026-11-06T23:01:11.196Z')
  const never = await boatReplying(sandbox({})).provider.saved!(ref)
  assert.deepEqual(never, { savedAt: null, snapshotAt: null, health: null, healthReason: null })
})

test('the ledger lists every sandbox page by page, and reads one’s usage unscaled', async () => {
  const asked: string[] = []
  const send = (async (url: string | URL | Request) => {
    const u = new URL(String(url))
    asked.push(u.pathname.replace('/api/v1', '') + u.search)
    const body = u.pathname.endsWith('/usage')
      ? {
          ok: true,
          type: 'sandbox.usage',
          sandboxId: 'sb2',
          sandboxType: 'large',
          billingMultiplier: 2,
          since: '2026-11-01T00:00:00.000Z',
          until: '2026-11-02T00:00:00.000Z',
          seconds: 7200,
          dollars: 0.072,
          secondsPerDollar: 100000,
          running: false,
        }
      : u.searchParams.get('cursor')
        ? {
            ok: true,
            type: 'sandbox.list',
            sandboxes: [
              {
                id: 'sb3',
                state: 'provisioning',
                desktopAvailable: false,
                snapshotAvailable: false,
              },
            ],
            pageInfo: { hasMore: false, nextCursor: null, limit: 100 },
          }
        : {
            ok: true,
            type: 'sandbox.list',
            sandboxes: [
              { id: 'sb1', state: 'idle', desktopAvailable: false, snapshotAvailable: false },
              { id: 'sb2', state: 'archived', desktopAvailable: false, snapshotAvailable: false },
              { id: 'sb4', state: 'error', desktopAvailable: false, snapshotAvailable: false },
            ],
            pageInfo: { hasMore: true, nextCursor: 'c2', limit: 100 },
          }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const ledger = createBoatLedger({ apiKey: 'key', basePath: 'https://boat.test/api/v1', send })
  assert.deepEqual(
    [...(await ledger.states())],
    [
      ['sb1', 'running'],
      ['sb2', 'stopped'],
      ['sb4', 'error'],
      ['sb3', 'starting'],
    ],
  )
  assert.deepEqual(asked, ['/sandboxes?limit=100', '/sandboxes?limit=100&cursor=c2'])
  const usage = await ledger.usage(
    'sb2',
    new Date('2026-11-01T00:00:00Z'),
    new Date('2026-11-02T00:00:00Z'),
  )
  // 7200 billable seconds of a large VM (twice a default's rate): one hour of it running.
  assert.deepEqual(usage, { runSeconds: 3600, dollars: 0.072, running: false })
  assert.match(
    asked.at(-1)!,
    /^\/sandboxes\/sb2\/usage\?since=2026-11-01T00%3A00%3A00.000Z&until=2026-11-02T00%3A00%3A00.000Z$/,
  )
  // The same hour at Brigade's own constants.
  assert.equal(vmCost('8x16', 1), VM_PRICES.hourly['8x16'])
  assert.equal(vmCost('8x16', 1), usage.dollars)
})
