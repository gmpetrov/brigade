import assert from 'node:assert/strict'
import { test } from 'node:test'

// A domain's records added on Cloudflare (src/mail/cloudflare-dns.ts): the names Resend gives,
// made whole, and the script Cloudflare's MCP server runs, run here against a fake Cloudflare
// API. Public DNS is played by a fake fetch.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const RECORDS = [
  { type: 'TXT', name: 'resend._domainkey', value: 'p=KEY' },
  { type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all' },
  { type: 'CNAME', name: 'rsend', value: 'send.forge.rmta.net' },
]

type Row = { id: string; type: string; name: string; content: string; priority?: number }

/** Cloudflare's API as the script sees it: zones, and each zone's records. */
function fakeCloudflare(zones: Record<string, Row[]>, refuse?: string) {
  const writes: unknown[] = []
  const cloudflare = {
    async request(options: {
      method: string
      path: string
      query?: Record<string, unknown>
      body?: Row
    }) {
      if (refuse) return { success: false, errors: [{ message: refuse }], result: null }
      if (options.path === '/zones') {
        const name = String(options.query?.name)
        return { success: true, result: name in zones ? [{ id: name, name }] : [] }
      }
      const zone = options.path.split('/')[2]!
      if (options.method === 'GET')
        return {
          success: true,
          result: zones[zone]!.filter((r) => r.name === options.query?.name),
        }
      writes.push(options.body)
      zones[zone]!.push({ id: `r${writes.length}`, ...options.body! })
      return { success: true, result: options.body }
    },
  }
  return { cloudflare, writes }
}

async function run(code: string, cloudflare: unknown) {
  const script = new Function('cloudflare', `return (${code})()`) as (c: unknown) => Promise<{
    zone: string | null
    results: { name: string; type: string; result: string; note?: string }[]
    error?: string
  }>
  return script(cloudflare)
}

test('Resend’s record names, made whole: apex, subdomain, and names whole already', async () => {
  const { fqdnOf, zoneCandidates } = await import('../src/mail/cloudflare-dns.js')
  assert.equal(fqdnOf('send', 'brigade.lol'), 'send.brigade.lol')
  assert.equal(fqdnOf('resend._domainkey', 'brigade.lol'), 'resend._domainkey.brigade.lol')
  assert.equal(fqdnOf('send.team', 'team.acme.com'), 'send.team.acme.com')
  assert.equal(fqdnOf('resend._domainkey.team', 'team.acme.com'), 'resend._domainkey.team.acme.com')
  assert.equal(fqdnOf('send.a.b', 'a.b.acme.com'), 'send.a.b.acme.com')
  assert.equal(fqdnOf('send.team.acme.com.', 'team.acme.com'), 'send.team.acme.com')
  assert.equal(fqdnOf('@', 'acme.com'), 'acme.com')
  assert.deepEqual(zoneCandidates('team.acme.com'), ['team.acme.com', 'acme.com'])
  assert.deepEqual(zoneCandidates('acme.com'), ['acme.com'])
})

test('on Cloudflare: missing records are added, ones in place kept, clashing ones left alone', async () => {
  const { addRecordsCode } = await import('../src/mail/cloudflare-dns.js')
  const zones: Record<string, Row[]> = {
    'acme.com': [
      // In place already, as Cloudflare writes TXT: quoted.
      { id: 'a', type: 'TXT', name: 'resend._domainkey.team.acme.com', content: '"p=KEY"' },
      // Another SPF at send: two would break both, so it is reported, not replaced.
      { id: 'b', type: 'TXT', name: 'send.team.acme.com', content: '"v=spf1 include:other ~all"' },
      // Google's mail at the apex: untouched.
      { id: 'c', type: 'MX', name: 'acme.com', content: 'aspmx.l.google.com', priority: 1 },
    ],
  }
  const { cloudflare, writes } = fakeCloudflare(zones)
  const named = RECORDS.map((r) => ({ ...r, name: r.name === 'rsend' ? r.name : `${r.name}.team` }))
  const answer = await run(addRecordsCode('team.acme.com', [...named, RECORDS[3]!]), cloudflare)
  assert.equal(answer.zone, 'acme.com')
  assert.deepEqual(
    answer.results.map((r) => [r.type, r.name, r.result]),
    [
      ['TXT', 'resend._domainkey.team.acme.com', 'present'],
      ['MX', 'send.team.acme.com', 'added'],
      ['TXT', 'send.team.acme.com', 'conflict'],
      ['CNAME', 'rsend.team.acme.com', 'added'],
      ['CNAME', 'rsend.team.acme.com', 'present'],
    ],
  )
  assert.match(answer.results[2]!.note!, /include:other/)
  assert.deepEqual(writes, [
    {
      type: 'MX',
      name: 'send.team.acme.com',
      content: 'feedback-smtp.us-east-1.amazonses.com',
      ttl: 1,
      priority: 10,
      comment: 'Added by Brigade for its mail',
    },
    {
      type: 'CNAME',
      name: 'rsend.team.acme.com',
      content: 'send.forge.rmta.net',
      ttl: 1,
      proxied: false,
      comment: 'Added by Brigade for its mail',
    },
  ])
  // Google's MX at the apex is as it was.
  assert.equal(zones['acme.com']!.filter((r) => r.name === 'acme.com').length, 1)
})

test('a CNAME never goes where another record is, and an MX at another priority clashes', async () => {
  const { addRecordsCode } = await import('../src/mail/cloudflare-dns.js')
  const { cloudflare, writes } = fakeCloudflare({
    'acme.com': [
      { id: 'a', type: 'A', name: 'rsend.acme.com', content: '192.0.2.1' },
      {
        id: 'b',
        type: 'MX',
        name: 'send.acme.com',
        content: 'feedback-smtp.us-east-1.amazonses.com',
        priority: 5,
      },
    ],
  })
  const answer = await run(addRecordsCode('acme.com', [RECORDS[1]!, RECORDS[3]!]), cloudflare)
  assert.deepEqual(
    answer.results.map((r) => r.result),
    ['conflict', 'conflict'],
  )
  assert.deepEqual(writes, [])
})

test('no zone for the domain in the account, and Cloudflare refusing, change nothing', async () => {
  const { addRecordsCode, readAnswer } = await import('../src/mail/cloudflare-dns.js')
  const none = fakeCloudflare({ 'other.com': [] })
  assert.deepEqual(await run(addRecordsCode('acme.com', RECORDS), none.cloudflare), {
    zone: null,
    results: [],
  })
  const refused = fakeCloudflare({}, 'Authentication error')
  assert.deepEqual(await run(addRecordsCode('acme.com', RECORDS), refused.cloudflare), {
    error: 'Authentication error',
  })
  assert.deepEqual([...none.writes, ...refused.writes], [])

  // The tool's answer, as JSON text, as a value, or wrapped in a result.
  const value = { zone: 'acme.com', results: [] }
  assert.deepEqual(readAnswer(JSON.stringify(value)), value)
  assert.deepEqual(readAnswer(value), value)
  assert.deepEqual(readAnswer({ result: value }), value)
  assert.deepEqual(readAnswer('Script failed: boom'), { error: 'Script failed: boom' })
})

test('a domain is on Cloudflare when its closest zone’s nameservers are Cloudflare’s', async () => {
  const { dnsOnCloudflare } = await import('../src/mail/cloudflare-dns.js')
  const ns: Record<string, string[]> = {
    'acme.com': ['ada.ns.cloudflare.com.', 'bob.ns.cloudflare.com.'],
    'google.test': ['ns1.google.com.'],
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const name = new URL(String(input)).searchParams.get('name') ?? ''
    return Response.json(
      name in ns
        ? { Status: 0, Answer: ns[name]!.map((data) => ({ type: 2, data })) }
        : { Status: 0, Answer: [] },
    )
  }) as typeof fetch
  try {
    assert.equal(await dnsOnCloudflare('team.acme.com'), true)
    assert.equal(await dnsOnCloudflare('acme.com'), true)
    assert.equal(await dnsOnCloudflare('mail.google.test'), false)
    assert.equal(await dnsOnCloudflare('nowhere.test'), false)
  } finally {
    globalThis.fetch = previousFetch
  }
})
