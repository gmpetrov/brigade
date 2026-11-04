import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

// GitHub answering 5xx for a while (PostHog, Nov 3: "GitHub: 503: Service Unavailable" on each
// pull request view for 14 minutes), src/pull-requests.ts:
// - a read GitHub answers 500, 502, 503 or 504 is asked again after a short wait, a 4xx never,
//   nor a write;
// - a 5xx that still fails fails the request, and is reported once per outage, never for a blip
//   shorter than a minute; a 4xx fails as before, reported by the API's error handler.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const {
  askAgain,
  pullOf,
  reportOutage,
  forgetOutage,
  RETRY_WAITS_MS,
  OUTAGE_REPORT_MS,
  OUTAGE_GAP_MS,
} = await import('../src/pull-requests.js')
const { isTracked } = await import('../src/error-tracking.js')
const { HTTPException } = await import('hono/http-exception')

/** GitHub answering these statuses in turn (the last one again after), and the asks it got. */
function github(...statuses: number[]) {
  const asked: number[] = []
  const send = async () => {
    const status = statuses[Math.min(asked.length, statuses.length - 1)]!
    asked.push(status)
    return status === 200
      ? Response.json({ number: 7, state: 'open' })
      : Response.json({ message: status >= 500 ? 'Service Unavailable' : 'Not Found' }, { status })
  }
  return { asked, send }
}

describe('a GitHub read answered 5xx', () => {
  test('500, 502, 503 and 504 are asked again, and the answer that worked is returned', async () => {
    for (const status of [500, 502, 503, 504]) {
      const gh = github(status, 200)
      const response = await askAgain('GET', gh.send, [1, 1])
      assert.equal(response.status, 200, `after a ${status}`)
      assert.deepEqual(gh.asked, [status, 200])
    }
    // A call that gives no method is a GET.
    const gh = github(503, 503, 200)
    assert.equal((await askAgain(undefined, gh.send, [1, 1])).status, 200)
    assert.equal(gh.asked.length, 3)
  })

  test('after a short wait each time, and the last 5xx is returned once the waits are spent', async () => {
    assert.ok(RETRY_WAITS_MS.length >= 1, 'asked again at least once')
    const total = RETRY_WAITS_MS.reduce((a, b) => a + b, 0)
    assert.ok(total <= 3_000, 'short: a view is not held long')
    const gh = github(503)
    const started = performance.now()
    const response = await askAgain('GET', gh.send, [30, 60])
    assert.ok(performance.now() - started >= 85, 'waited before each ask')
    assert.equal(response.status, 503)
    assert.equal(gh.asked.length, 3)
  })

  test('a 4xx, a 501 and a write are asked once', async () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 501]) {
      const gh = github(status, 200)
      assert.equal((await askAgain('GET', gh.send, [1, 1])).status, status)
      assert.equal(gh.asked.length, 1, `a ${status}`)
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const gh = github(503, 200)
      assert.equal((await askAgain(method, gh.send, [1, 1])).status, 503)
      assert.equal(gh.asked.length, 1, `a ${method}`)
    }
  })
})

describe('a GitHub outage, reported', () => {
  beforeEach(() => forgetOutage())

  test('once it lasted a minute, then not again while it lasts', () => {
    const t = 1_000_000
    assert.equal(reportOutage(t), false, 'a blip')
    assert.equal(reportOutage(t + OUTAGE_REPORT_MS - 1), false, 'still under a minute')
    assert.equal(reportOutage(t + OUTAGE_REPORT_MS), true, 'an outage')
    for (let i = 1; i <= 14; i++)
      assert.equal(reportOutage(t + OUTAGE_REPORT_MS + i * 60_000), false, 'reported already')
  })

  test('a blip under a minute is never reported, and a later one starts afresh', () => {
    const t = 1_000_000
    assert.equal(reportOutage(t), false)
    assert.equal(reportOutage(t + 50_000), false)
    // GitHub answered for a while: the next 5xx is a new outage, not the first one's tail.
    const later = t + 50_000 + OUTAGE_GAP_MS + 1
    assert.equal(reportOutage(later), false)
    assert.equal(reportOutage(later + 30_000), false)
    assert.equal(reportOutage(later + OUTAGE_REPORT_MS), true)
  })

  test("a view's 5xx fails as a 502 the error handler does not send again; a 4xx it does", async () => {
    const answering = (status: number) => ({ fetch: () => github(status).send() })
    const failed = await pullOf(answering(503), 'acme/web', 7).catch((e: unknown) => e)
    assert.ok(failed instanceof HTTPException)
    assert.equal(failed.status, 502)
    assert.equal(failed.message, 'GitHub: 503: Service Unavailable')
    assert.ok(isTracked(failed), 'reported once per outage, not by each request')

    const missing = await pullOf(answering(404), 'acme/web', 7).catch((e: unknown) => e)
    assert.ok(missing instanceof HTTPException)
    assert.equal(missing.status, 502)
    assert.ok(!isTracked(missing), 'a 4xx is reported as before')

    assert.equal((await pullOf(answering(200), 'acme/web', 7)).number, 7)
  })
})
