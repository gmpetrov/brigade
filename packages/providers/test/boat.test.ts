import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOAT_COMMAND_GRACE_MS,
  BOAT_REQUEST_MS,
  boatClient,
  boatDeadlineMs,
  createBoatProvider,
} from '../src/boat/index.js'
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
