import assert from 'node:assert/strict'
import { test } from 'node:test'

// Who a domain's mail is with, from its MX (src/mail/domains.ts): what a mailbox's page shows the
// forwarding steps for. Public DNS is played by a fake fetch.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

test('a domain’s mail provider: Google, Microsoft 365, or another one when DNS says nothing clear', async () => {
  const { mailProviderOf } = await import('../src/mail/domains.js')
  const mx: Record<string, unknown> = {
    'google.test': { Status: 0, Answer: [{ type: 15, data: '1 aspmx.l.google.com.' }] },
    'old-google.test': { Status: 0, Answer: [{ type: 15, data: '10 aspmx2.googlemail.com.' }] },
    'microsoft.test': {
      Status: 0,
      Answer: [{ type: 15, data: '0 microsoft-test.mail.protection.outlook.com.' }],
    },
    'other.test': { Status: 0, Answer: [{ type: 15, data: '10 mx.fastmail.com.' }] },
    'lookalike.test': { Status: 0, Answer: [{ type: 15, data: '10 mx.notgoogle.com.' }] },
    'none.test': { Status: 3 },
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const name = new URL(String(input)).searchParams.get('name') ?? ''
    if (name === 'broken.test') return new Response('', { status: 500 })
    return Response.json(mx[name] ?? { Status: 0, Answer: [] })
  }) as typeof fetch
  try {
    assert.equal(await mailProviderOf('google.test'), 'google')
    assert.equal(await mailProviderOf('old-google.test'), 'google')
    assert.equal(await mailProviderOf('microsoft.test'), 'microsoft')
    assert.equal(await mailProviderOf('other.test'), 'other')
    assert.equal(await mailProviderOf('lookalike.test'), 'other')
    assert.equal(await mailProviderOf('none.test'), 'other')
    assert.equal(await mailProviderOf('broken.test'), 'other')
  } finally {
    globalThis.fetch = previousFetch
  }
})
