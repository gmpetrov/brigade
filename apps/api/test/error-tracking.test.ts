import assert from 'node:assert/strict'
import { afterEach, after, test } from 'node:test'

// Error tracking (src/error-tracking.ts): the API's errors and the dashboard's reports, sent to
// PostHog as `$exception` events with their frames, scrubbed of keys, addresses, links' paths and
// pages' ids, a few times a minute at most, and nothing without POSTHOG_KEY; the dashboard's
// reports read only up to their size limit, and not at all past a person's limit. PostHog is a
// stub of fetch here, the session a stub of better-auth's. No database.
process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.POSTHOG_KEY = ''
process.env.WEB_URL = 'https://www.brigade.test'

const tracking = await import('../src/error-tracking.js')
const { flushAnalytics } = await import('../src/analytics.js')
const { noteFailure } = await import('../src/ops/failures.js')
const { env } = await import('../src/config.js')
const { auth } = await import('../src/auth.js')
const { app } = await import('../src/app.js')
const { errors, REPORT_MAX_BYTES } = await import('../src/routes/errors.js')
const { HTTPException } = await import('hono/http-exception')

type Batch = { api_key: string; batch: Record<string, any>[] }
const sent: Batch[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.includes('posthog')) return realFetch(input, init)
  sent.push(JSON.parse(String(init?.body)))
  return new Response('{}', { status: 200 })
}) as typeof fetch

const exceptions = async () => {
  await flushAnalytics()
  return sent.flatMap((s) => s.batch).filter((e) => e.event === '$exception')
}
afterEach(async () => {
  await flushAnalytics()
  env.POSTHOG_KEY = undefined
  sent.length = 0
})
const realSession = auth.api.getSession
after(() => {
  globalThis.fetch = realFetch
  auth.api.getSession = realSession
})

let n = 0
/** A message no other test sends, so the per-minute limit never mixes them. */
const unique = (text: string) => `${text} #${++n}`

test('a message loses its email addresses and the paths of its links', () => {
  assert.equal(
    tracking.scrubMessage(
      'GET https://api.github.com/repos/acme/secret-plans/pulls?token=x failed for ada@acme.io',
    ),
    'GET https://api.github.com/… failed for [email]',
  )
  assert.equal(
    tracking.scrubMessage('down: https://status.example.com'),
    'down: https://status.example.com',
  )
  assert.equal(tracking.scrubMessage('two\n  lines'), 'two lines')
  assert.equal(tracking.scrubMessage('x'.repeat(2_000)).length, 500)
})

test("a page keeps only its first two segments: never a thread's id or a repository's name", () => {
  assert.equal(tracking.scrubPath('/app/pulls/acme/secret-plans/12'), '/app/pulls')
  assert.equal(tracking.scrubPath('/app/threads/abc?x=1#y'), '/app/threads')
  assert.equal(tracking.scrubPath('/app'), '/app')
  assert.equal(tracking.scrubPath('/'), '/')
})

test('the same error goes 5 times a minute at most', () => {
  const key = unique('limit')
  const t = 1_000_000
  const allowed = Array.from({ length: 8 }, (_, i) => tracking.mayGo(key, t + i))
  assert.deepEqual(allowed, [true, true, true, true, true, false, false, false])
  assert.equal(tracking.mayGo(key, t + 60_000), true)
})

test('without POSTHOG_KEY, nothing is sent', async () => {
  tracking.captureError(new Error(unique('quiet')), { kind: 'api' })
  assert.equal((await exceptions()).length, 0)
})

test("an API error goes with its frames, its causes and the workspace's group", async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const message = unique('database gone for ada@acme.io')
  const error = new Error(message, { cause: new TypeError('socket closed') })
  error.stack = `Error: ${message}\n    at loadThread (worker.js:120:15)\n    at async Api.fetch (worker.js:40:3)`
  tracking.captureError(error, { kind: 'job:cloud-plans', workspaceId: 'ws-1' })
  const [event, ...more] = await exceptions()
  assert.equal(more.length, 0)
  assert.equal(event!.distinct_id, 'workspace:ws-1')
  const p = event!.properties
  assert.equal(p.source, 'api')
  assert.equal(p.kind, 'job:cloud-plans')
  assert.equal(p.$exception_level, 'error')
  assert.deepEqual(p.$groups, { workspace: 'ws-1' })
  assert.equal(p.$process_person_profile, false)
  const [first, cause] = p.$exception_list
  assert.equal(first.type, 'Error')
  assert.ok(!first.value.includes('ada@acme.io'))
  assert.deepEqual(first.mechanism, {
    type: 'generic',
    handled: false,
    synthetic: false,
    exception_id: 0,
  })
  // PostHog's order: the outermost call first, the line that threw last.
  assert.deepEqual(
    first.stacktrace.frames.map((f: any) => [f.function, f.filename, f.lineno]),
    [
      ['Api.fetch', 'worker.js', 40],
      ['loadThread', 'worker.js', 120],
    ],
  )
  assert.equal(first.stacktrace.frames[0].platform, 'node:javascript')
  assert.equal(cause.type, 'TypeError')
  assert.equal(cause.value, 'socket closed')
  assert.equal(cause.mechanism.parent_id, 0)
})

test('a failure the ops checks count goes too when it carries an error, not when only a line', async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  noteFailure('job:sweep', new Error(unique('sweep threw')), { workspaceId: 'ws-2' })
  noteFailure('stripe-signature', unique('a request failed its signature check'))
  const sent = await exceptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.properties.kind, 'job:sweep')
  assert.deepEqual(sent[0]!.properties.$groups, { workspace: 'ws-2' })
})

const chromeStack = (message: string, file: string) =>
  `TypeError: ${message}\n    at ThreadView (${file}:1:2345)\n    at renderWithHooks (${file}:1:999)`

test("a dashboard report goes as the person's, with its page cut short", async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const value = unique("Cannot read properties of undefined (reading 'title')")
  const file = 'https://www.brigade.test/_next/static/chunks/app.js?v=abc'
  assert.equal(
    tracking.captureReport(
      {
        type: 'TypeError',
        value,
        stack: chromeStack(value, file),
        how: 'boundary',
        build: 'a1b2c3d',
        path: '/app/pulls/acme/secret-plans/12',
      },
      { userId: 'user-1', workspaceId: 'ws-3' },
    ),
    true,
  )
  const [event] = await exceptions()
  assert.equal(event!.distinct_id, 'user-1')
  const p = event!.properties
  assert.equal(p.source, 'dashboard')
  assert.equal(p.how, 'boundary')
  assert.equal(p.build, 'a1b2c3d')
  assert.equal(p.path, '/app/pulls')
  assert.equal(p.$process_person_profile, undefined)
  const [exception] = p.$exception_list
  assert.equal(exception.mechanism.type, 'react_error_boundary')
  assert.equal(exception.mechanism.handled, true)
  assert.deepEqual(
    exception.stacktrace.frames.map((f: any) => [f.function, f.filename, f.platform]),
    [
      ['renderWithHooks', 'https://www.brigade.test/_next/static/chunks/app.js', 'web:javascript'],
      ['ThreadView', 'https://www.brigade.test/_next/static/chunks/app.js', 'web:javascript'],
    ],
  )
})

test("a report whose stack holds none of the dashboard's scripts is dropped: an extension's", async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const value = unique('extension broke')
  assert.equal(
    tracking.captureReport(
      {
        type: 'TypeError',
        value,
        stack: chromeStack(value, 'chrome-extension://abcdef/content.js'),
        how: 'uncaught',
      },
      { userId: 'user-1' },
    ),
    false,
  )
  // Without a stack it goes: nothing says it is another's.
  assert.equal(
    tracking.captureReport(
      { type: 'Error', value: unique('rejected with a string'), how: 'unhandled_rejection' },
      { userId: 'user-1' },
    ),
    true,
  )
  const sent = await exceptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.properties.$exception_list[0].mechanism.type, 'onunhandledrejection')
})

test('keys and tokens leave no trace, even masked, in a message or its causes', async () => {
  assert.equal(
    tracking.scrubMessage('Invalid API Key provided: sk_live_****ABCD'),
    'Invalid API Key provided: [redacted key]',
  )
  assert.equal(
    tracking.scrubMessage('auth: Bearer abc.def-123 and eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'),
    'auth: Bearer [redacted] and [redacted token]',
  )
  env.POSTHOG_KEY = 'phc_test_key'
  const error = new Error(unique('billing failed'), {
    cause: new Error('Invalid API Key provided: rk_live_1234****WXYZ'),
  })
  tracking.captureError(error, { kind: 'api:GET /api/billing' })
  const [event] = await exceptions()
  const text = JSON.stringify(event!.properties.$exception_list)
  assert.ok(!text.includes('rk_live'), text)
  assert.ok(!text.includes('WXYZ'), text)
})

test('a refusal is not sent; a failure said on purpose (5xx) is, as handled', async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const tag = unique('upstream')
  app.get(`/test-refused-${n}`, () => {
    throw new HTTPException(404, { message: 'No such thing' })
  })
  app.get(`/test-upstream-${n}`, () => {
    throw new HTTPException(502, { message: `GitHub did not answer ${tag}` })
  })
  assert.equal((await app.request(`/test-refused-${n}`)).status, 404)
  assert.equal((await app.request(`/test-upstream-${n}`)).status, 502)
  const sent = await exceptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.properties.$exception_list[0].mechanism.handled, true)
  assert.match(sent[0]!.properties.kind, /^api:GET \/test-upstream-/)
})

/** A request body in chunks of 64 KB, pulled only as read, counting what the route read of it. */
function chunked(prefix: string, chunks: number) {
  const chunk = new Uint8Array(65_536).fill(120)
  const parts = [new TextEncoder().encode(prefix), ...Array.from({ length: chunks }, () => chunk)]
  const read = { bytes: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const part = parts.shift()
        if (!part) return controller.close()
        read.bytes += part.byteLength
        controller.enqueue(part)
      },
    },
    { highWaterMark: 0 },
  )
  return { body, read }
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  errors.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      duplex: 'half',
    } as RequestInit),
  )

test("a report is read only up to its limit, and a person's 31st in a minute not at all", async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const userId = `user-${unique('limits')}`
  auth.api.getSession = (async () => ({
    user: { id: userId },
    session: { id: 'session-1' },
  })) as unknown as typeof auth.api.getSession

  // 4 MB in chunks, with no length said: refused once past the limit, the rest never pulled.
  const big = chunked('{"type":"Error","how":"uncaught","value":"', 64)
  assert.equal((await post(big.body)).status, 413)
  assert.ok(big.read.bytes <= REPORT_MAX_BYTES + 65_536 + 64, `read ${big.read.bytes} bytes`)
  // A length said over the limit: refused before reading anything.
  const said = chunked('{', 1)
  assert.equal((await post(said.body, { 'content-length': String(1_000_000) })).status, 413)
  assert.equal(said.read.bytes, 0)

  const report = (value: string) => JSON.stringify({ type: 'Error', value, how: 'uncaught' })
  assert.equal((await post(report(unique('fine')))).status, 204)
  assert.equal((await exceptions()).length, 1)
  for (let i = 0; i < 27; i++) await post(report(unique('more')))
  // The 31st in this minute (two refused, one sent, 27 more): dropped, its body never pulled.
  const over = chunked(report(unique('over')), 0)
  assert.equal((await post(over.body)).status, 204)
  assert.equal(over.read.bytes, 0)
})
