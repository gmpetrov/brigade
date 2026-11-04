import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, mock, test } from 'node:test'

// A cloud computer's desktop (desktopUrl, src/cloud.ts) when its provider is slow. On Nov 4, boat
// kept a running computer's desktop "provisioning" for more than 5 minutes: each request for it
// was held 5 minutes, then failed, and every thread's panel waiting on that one provider call
// sent its own copy of the error. Now a desktop still being set up is a 503 the dashboard asks
// again for, without an error, until it opens; one failed provider call is sent once, however
// many requests wait on it; a desktop still not set up after 10 minutes is sent, once.
// boat and PostHog are faked. No database.
process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.POSTHOG_KEY = ''
process.env.BOAT_API_KEY = 'test'
// One look at boat's desktop per provider call: the wait between looks is the dashboard's.
process.env.BOAT_DESKTOP_WAIT_MS = '0'

// boat, faked: what its desktop answers, and how often it was asked.
const { BoatApi } = createRequire(
  new URL('../../../packages/providers/package.json', import.meta.url),
)('@boatdev/sdk') as typeof import('@boatdev/sdk')
const boat = {
  asked: 0,
  answer: (): Promise<object> => Promise.resolve({ provisioning: true }),
}
Object.assign(BoatApi.prototype, {
  desktop: async () => {
    boat.asked++
    return { ok: true, type: 'desktop', ...(await boat.answer()) }
  },
})

const { env } = await import('../src/config.js')
const { app } = await import('../src/app.js')
const { flushAnalytics } = await import('../src/analytics.js')
const { desktopUrl, DESKTOP_PREPARING, DESKTOP_PREPARING_REPORT_MS } =
  await import('../src/cloud.js')

const sent: Record<string, any>[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.includes('posthog')) return realFetch(input, init)
  sent.push(...JSON.parse(String(init?.body)).batch)
  return new Response('{}', { status: 200 })
}) as typeof fetch
const exceptions = async () => {
  await flushAnalytics()
  return sent.filter((e) => e.event === '$exception')
}
afterEach(async () => {
  await flushAnalytics()
  mock.timers.reset()
  sent.length = 0
  boat.asked = 0
})
after(() => {
  globalThis.fetch = realFetch
  env.POSTHOG_KEY = undefined
})

// The desktop routes (POST /threads/:id/desktop, POST /computers/:id/desktop), short of their
// database: what they do after ensureRunning, through the API's own error handler.
let n = 0
function route() {
  const path = `/test-desktop-${++n}`
  const providerRef = { provider: 'boat', id: `sb${n}` }
  app.post(path, async (c) => c.json({ url: await desktopUrl({ providerRef }) }))
  return () => app.request(path, { method: 'POST' })
}
// Each test's own computer; routes are added before the first request.
const computers = [route(), route(), route()]

test('a desktop still being set up is a 503 to ask again for, and opens once it is up', async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const open = computers[0]!
  const first = await open()
  assert.equal(first.status, 503)
  assert.deepEqual(await first.json(), { error: DESKTOP_PREPARING })
  assert.equal((await open()).status, 503)
  boat.answer = async () => ({ desktopUrl: 'https://vnc.test/?password=p' })
  const ready = await open()
  assert.equal(ready.status, 200)
  assert.deepEqual(await ready.json(), { url: 'https://vnc.test/?password=p' })
  assert.equal(boat.asked, 3)
  assert.deepEqual(await exceptions(), [], 'a desktop being set up is not an error')
})

test('one failed provider call is sent once, however many requests wait on it', async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  const open = computers[1]!
  let fail!: (error: Error) => void
  boat.answer = () => new Promise((_, reject) => (fail = reject))
  // Three threads' panels ask for the same computer's desktop at once.
  const waiting = [open(), open(), open()]
  await new Promise((resolve) => setTimeout(resolve, 20))
  fail(new Error('boat is down'))
  const answers = await Promise.all(waiting)
  assert.deepEqual(
    answers.map((r) => r.status),
    [503, 503, 503],
  )
  assert.equal(boat.asked, 1, 'they shared one provider call')
  const sentNow = await exceptions()
  assert.equal(sentNow.length, 1)
  assert.match(
    sentNow[0]!.properties.$exception_list[0].value,
    /provider did not answer: boat is down/,
  )
  assert.equal(sentNow[0]!.properties.kind, 'cloud:desktop')
})

test('a desktop still not set up after 10 minutes is sent once', async () => {
  env.POSTHOG_KEY = 'phc_test_key'
  boat.answer = async () => ({ provisioning: true })
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const open = computers[2]!
  assert.equal((await open()).status, 503)
  mock.timers.tick(DESKTOP_PREPARING_REPORT_MS - 1)
  assert.equal((await open()).status, 503)
  assert.deepEqual(await exceptions(), [])
  mock.timers.tick(1)
  assert.equal((await open()).status, 503)
  mock.timers.tick(60_000)
  assert.equal((await open()).status, 503)
  const sentNow = await exceptions()
  assert.equal(sentNow.length, 1)
  assert.match(sentNow[0]!.properties.$exception_list[0].value, /still being prepared after 10/)
})
