import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { googleAccount, mayRevokeGoogle } from '../src/connectors/google-oauth.js'

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

test("Calendar names its account from the calendar list's primary calendar", async () => {
  google({ 'calendarList/primary': { id: 'ada@example.com' } })
  assert.equal(await googleAccount('google_calendar', 'token'), 'ada@example.com')
})

test('Calendar names its account from its events when the calendar list was not granted', async () => {
  const asked = google({ 'calendars/primary/events': { summary: 'ada@example.com', items: [] } })
  assert.equal(await googleAccount('google_calendar', 'token'), 'ada@example.com')
  assert.equal(asked.length, 2)
})

test('Calendar names no account when neither says an address', async () => {
  google({ 'calendars/primary/events': { summary: 'Team calendar' } })
  assert.equal(await googleAccount('google_calendar', 'token'), null)
})
