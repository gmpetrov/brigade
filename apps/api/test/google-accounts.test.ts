import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

// The module reads the server's config: a dummy one, as the other tests do.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { googleAccount, mayRevokeGoogle, removeAndRevokeGoogle } =
  await import('../src/connectors/google-oauth.js')

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Answers each Google URL with its body, or a 403 for those left out. */
function google(bodies: Record<string, unknown>) {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    const hit = Object.entries(bodies).find(([part]) => url.includes(part))
    return hit
      ? new Response(JSON.stringify(hit[1]), { status: 200 })
      : new Response(JSON.stringify({ error: { code: 403 } }), { status: 403 })
  }) as typeof fetch
  return asked
}

test('a Google account still used by another connection is not revoked', () => {
  assert.equal(mayRevokeGoogle('ada@example.com', []), true)
  assert.equal(mayRevokeGoogle('ada@example.com', [{ externalAccount: 'bob@example.com' }]), true)
  assert.equal(mayRevokeGoogle('Ada@Example.com', [{ externalAccount: 'ada@example.com' }]), false)
  // Unknown address: nothing says it is shared, so it is revoked as before.
  assert.equal(mayRevokeGoogle(null, [{ externalAccount: 'ada@example.com' }]), true)
})

test("Calendar names its account from the signed-in user's address", async () => {
  google({
    'openidconnect.googleapis.com/v1/userinfo': { email: 'ada@example.com' },
    'calendarList/primary': { id: 'someone-else@example.com' },
  })
  assert.equal(await googleAccount('google_calendar', 'token'), 'ada@example.com')
})

test('Calendar connected before it asked for the address names it from its primary calendar', async () => {
  google({ 'calendarList/primary': { id: 'ada@example.com' } })
  assert.equal(await googleAccount('google_calendar', 'token'), 'ada@example.com')
})

test("Calendar never names its account from a calendar's title, which anyone can rename", async () => {
  const asked = google({ 'calendars/primary/events': { summary: 'bob@example.com', items: [] } })
  assert.equal(await googleAccount('google_calendar', 'token'), null)
  assert.ok(!asked.some((url) => url.includes('/events')))
})

/** Two connections of one Google account, disconnected at once, with the steps interleaved. */
async function disconnectBoth(order: 'marks first' | 'one checks first') {
  const active = new Set(['a', 'b'])
  let revoked = 0
  let marked = 0
  let release!: () => void
  const bothMarked = new Promise<void>((resolve) => (release = resolve))
  const remove = (id: string, waitForOther: boolean) =>
    removeAndRevokeGoogle({
      markRemoved: async () => {
        active.delete(id)
        if (++marked === 2) release()
      },
      usedElsewhere: async () => {
        if (waitForOther) await bothMarked
        return [...active].some((other) => other !== id)
      },
      revoke: async () => {
        revoked++
      },
    })
  if (order === 'marks first') await Promise.all([remove('a', true), remove('b', true)])
  else {
    await remove('a', false)
    await remove('b', false)
  }
  return revoked
}

test('the last two connections of an account disconnected at once still revoke it', async () => {
  assert.ok((await disconnectBoth('marks first')) >= 1)
  assert.equal(await disconnectBoth('one checks first'), 1)
})
