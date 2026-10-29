import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, afterEach, test } from 'node:test'
import pg from 'pg'

// Product analytics (src/analytics.ts, src/analytics-events.ts, src/signup-source.ts): where a
// sign-up came from, which audit entries send which events and with nothing but enums and
// counts, nothing sent without POSTHOG_KEY, and the sign-up's origin kept once. PostHog is a
// stub of fetch here. The parts on the database skip without one to reach.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.PASSWORD_SIGN_IN = 'false'
process.env.RESEND_API_KEY = ''
process.env.POSTHOG_KEY = ''
process.env.POSTHOG_INTERNAL_EMAIL_DOMAINS = 'brigade.lol, @team.example'
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "userId" from "AnalyticsFirst" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { parseSignupSource, channelOfReferrer, signupProperties } =
  await import('../src/signup-source.js')
const { AUDIT_EVENTS, emissionsOf, ENUM_VALUE, SAFE_KEYS, safeProps } =
  await import('../src/analytics-events.js')
const analytics = await import('../src/analytics.js')
const { env } = await import('../src/config.js')
const { auth } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')

// ---------------------------------------------------------------------------
// PostHog, stubbed

type Sent = { url: string; body: { api_key: string; batch: Record<string, any>[] } }
const sent: Sent[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.includes('posthog')) return realFetch(input, init)
  sent.push({ url, body: JSON.parse(String(init?.body)) })
  return new Response('{}', { status: 200 })
}) as typeof fetch

const events = () => sent.flatMap((s) => s.body.batch)
const withKey = () => {
  env.POSTHOG_KEY = 'phc_test_key'
}
afterEach(async () => {
  await analytics.flushAnalytics()
  env.POSTHOG_KEY = undefined
  sent.length = 0
})

const run = randomUUID().slice(0, 8)
const emails: string[] = []
after(async () => {
  globalThis.fetch = realFetch
  if (!skip) await prisma.user.deleteMany({ where: { email: { in: emails } } })
  if (!skip) await prisma.verification.deleteMany({ where: { identifier: { contains: run } } })
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------
// Where a sign-up came from

test("each referrer's channel, as the tracking plan's table has it", () => {
  const cases: [string, string][] = [
    ['x.com', 'twitter'],
    ['t.co', 'twitter'],
    ['twitter.com', 'twitter'],
    ['google.com', 'google_organic'],
    ['google.co.uk', 'google_organic'],
    ['news.ycombinator.com', 'hacker_news'],
    ['producthunt.com', 'product_hunt'],
    ['github.com', 'github'],
    ['old.reddit.com', 'reddit'],
    ['linkedin.com', 'linkedin'],
    ['chatgpt.com', 'ai_search'],
    ['perplexity.ai', 'ai_search'],
    ['claude.ai', 'ai_search'],
    ['gemini.google.com', 'ai_search'],
    ['bing.com', 'other_search'],
    ['duckduckgo.com', 'other_search'],
    ['example.org', 'other'],
  ]
  for (const [host, channel] of cases) assert.equal(channelOfReferrer(host), channel, host)
  assert.equal(channelOfReferrer('google.com', true), 'other', 'a paid click is not organic')
})

test('utm_source names the channel before the referrer; nothing at all is direct', () => {
  assert.equal(parseSignupSource({}).channel, 'direct')
  assert.equal(parseSignupSource(null).channel, 'direct')
  assert.equal(
    parseSignupSource({ utm_source: 'hn', utm_medium: 'social', ref: 'x.com' }).channel,
    'hacker_news',
  )
  assert.equal(parseSignupSource({ utm_source: 'x' }).channel, 'twitter')
  assert.equal(parseSignupSource({ utm_source: 'Product Hunt' }).channel, 'product_hunt')
  assert.equal(parseSignupSource({ utm_source: 'acme', utm_medium: 'email' }).channel, 'newsletter')
  assert.equal(parseSignupSource({ utm_source: 'somewhere' }).channel, 'other')
  assert.equal(parseSignupSource({ ref: 'www.google.fr' }).channel, 'google_organic')
  assert.equal(parseSignupSource({ ref: 'www.google.fr', paid: '1' }).channel, 'other')
})

test("what the browser sends is checked: a host, a path, short utm values, no URL's query", () => {
  const source = parseSignupSource({
    utm_source: 'hn',
    utm_medium: 'social',
    utm_campaign: 'launch<script>',
    ref: 'https://news.ycombinator.com/item?id=1',
    lp: '/how-it-works?email=ada@example.com',
    email: 'ada@example.com',
  })
  assert.deepEqual(source, {
    channel: 'hacker_news',
    source: 'hn',
    medium: 'social',
    campaign: 'launchscript',
    referrer: 'news.ycombinator.com',
    landingPage: '/how-it-works',
  })
  assert.equal(parseSignupSource({ ref: 'not a host' }).referrer, undefined)
  assert.equal(parseSignupSource({ lp: '//evil.example/x' }).landingPage, undefined)
  assert.equal(parseSignupSource({ utm_source: 'x'.repeat(500) }).source!.length, 80)
  assert.deepEqual(signupProperties(source, 'google'), {
    signup_channel: 'hacker_news',
    signup_method: 'google',
    signup_source: 'hn',
    signup_medium: 'social',
    signup_campaign: 'launchscript',
    signup_referrer: 'news.ycombinator.com',
    signup_landing_page: '/how-it-works',
  })
})

// ---------------------------------------------------------------------------
// Audit entries → events

const CONTENT = 'Secret plan for ada@example.com'
/** Data as the audit log has it, full of what must never leave: names, titles, paths, mail. */
const contentful = {
  name: CONTENT,
  title: CONTENT,
  path: '/Projects/Secret/plan.md',
  email: 'ada@example.com',
  to: ['bob@example.com'],
  subject: CONTENT,
  repository: 'acme/secret',
  account: 'ada@example.com',
  text: CONTENT,
  repositories: ['acme/secret', 'acme/other'],
  joined: ['t1'],
  attachmentIds: ['a', 'b', 'c'],
  fields: ['name', 'instructions'],
  harness: 'claude_code',
  provider: 'claude',
  platform: 'darwin-arm64',
  kind: 'github',
  role: 'admin',
  method: 'squash',
  event: 'gmail.email_received',
  eventType: 'github.pull_request',
  outcome: 'started',
  playbookKey: 'support',
  options: { query: CONTENT },
}

test('every mapped audit action sends only safe keys, and never any content', () => {
  for (const action of Object.keys(AUDIT_EVENTS))
    for (const actorType of ['member', 'teammate', 'system'] as const) {
      const out = emissionsOf({
        action,
        actorType,
        data: contentful,
        track: { origin: 'member', from: 'onboarding', kind: 'mac', note: CONTENT } as never,
      })
      assert.ok(out.length > 0, action)
      for (const emission of out) {
        assert.match(emission.event, /^[a-z]+(_[a-z]+)+$/, `${action}: object_verb`)
        assert.ok(emission.feature, `${action}: a feature`)
        assert.equal(emission.properties.feature, emission.feature)
        for (const [key, value] of Object.entries(emission.properties)) {
          assert.ok(SAFE_KEYS.has(key), `${action}: ${key} is not a safe key`)
          if (typeof value === 'string') assert.match(value, ENUM_VALUE, `${action}.${key}`)
          assert.ok(!String(value).includes('@'), `${action}.${key}: an address`)
          assert.ok(!String(value).includes('secret'), `${action}.${key}: content`)
          assert.ok(!String(value).includes('Secret'), `${action}.${key}: content`)
        }
      }
    }
})

test('the funnel and feature events carry what the plan names', () => {
  const one = (action: string, data: object, actorType = 'member' as const, track?: object) =>
    emissionsOf({ action, actorType, data, ...(track && { track: track as never }) })
  assert.deepEqual(one('teammate.created', { name: 'Ada', harness: 'codex' }), [
    {
      event: 'teammate_created',
      feature: 'teammates',
      properties: { harness: 'codex', feature: 'teammates' },
    },
  ])
  assert.deepEqual(
    one('thread.started', {}, 'member', { origin: 'member', harness: 'claude_code' }).map((e) => [
      e.event,
      e.properties.origin,
    ]),
    [
      ['thread_started', 'member'],
      ['message_sent', 'member'],
    ],
  )
  assert.deepEqual(
    one('thread.started', {}, 'system', { origin: 'schedule' }).map((e) => e.event),
    ['thread_started'],
    "a schedule's thread is no message sent",
  )
  assert.deepEqual(one('computer.linked', { platform: 'darwin-arm64' })[0]!.properties, {
    kind: 'own_machine',
    os: 'mac',
    feature: 'onboarding',
  })
  assert.equal(
    one('computer.linked', { platform: 'linux x64' }, 'system' as never)[0]!.properties.kind,
    'cloud',
  )
  assert.deepEqual(
    one('billing.checkout_started', {}, 'member', { from: 'onboarding' }).map((e) => [
      e.event,
      e.properties,
    ]),
    [
      ['checkout_started', { from: 'onboarding', feature: 'billing' }],
      ['computer_chosen', { kind: 'cloud', feature: 'onboarding' }],
    ],
  )
  assert.equal(one('pull_request.merged', { method: 'squash' })[0]!.properties.by, 'button')
  assert.equal(one('project.created', { repositories: ['a', 'b'] })[0]!.properties.repo_count, 2)
  assert.deepEqual(one('thread.renamed', { title: 'x' }), [], 'an action not mapped sends nothing')
})

test('safeProps keeps numbers, booleans and short words of known keys only', () => {
  assert.deepEqual(
    safeProps({
      kind: 'cloud',
      count: 3,
      first: true,
      title: 'Hello',
      origin: 'Has Spaces',
      app: '',
      amount: Number.NaN,
      provider: { nested: 1 },
    }),
    { kind: 'cloud', count: 3, first: true },
  )
})

test('internal people are matched by their domain, the address never sent', () => {
  assert.equal(analytics.isInternalEmail('georges@brigade.lol'), true)
  assert.equal(analytics.isInternalEmail('x@eu.team.example'), true)
  assert.equal(analytics.isInternalEmail('x@notbrigade.lol'), false)
  assert.equal(analytics.signupMethod('/sign-in/email-otp'), 'email_code')
  assert.equal(analytics.signupMethod('/callback/:id'), 'google')
})

// ---------------------------------------------------------------------------
// Sending

test('without POSTHOG_KEY, nothing is sent', async () => {
  analytics.track('signed_up', { distinctId: 'u1', properties: { channel: 'direct' } })
  analytics.trackAudit({
    organizationId: 'o',
    workspaceId: 'w',
    actor: { type: 'member', id: 'm' },
    action: 'teammate.created',
    target: { type: 'teammate', id: 't' },
    data: { harness: 'codex' },
  })
  analytics.identifyWorkspace('w')
  await analytics.flushAnalytics()
  assert.equal(sent.length, 0)
})

test('with a key, events go together to the EU host, with the workspace group', async () => {
  withKey()
  analytics.track('cta_clicked', { distinctId: 'u1', workspaceId: 'w1', properties: { kind: 'x' } })
  analytics.track('thread_started', {
    distinctId: 'workspace:w1',
    workspaceId: 'w1',
    organizationId: 'o1',
    personless: true,
    properties: { origin: 'trigger', title: 'never' } as never,
  })
  await analytics.flushAnalytics()
  assert.equal(sent.length, 1, 'one request')
  assert.equal(sent[0]!.url, 'https://eu.i.posthog.com/batch/')
  assert.equal(sent[0]!.body.api_key, 'phc_test_key')
  const [a, b] = sent[0]!.body.batch
  assert.deepEqual(a!.properties.$groups, { workspace: 'w1' })
  assert.equal(b!.properties.$process_person_profile, false)
  assert.equal(b!.properties.organization_id, 'o1')
  assert.equal(b!.properties.title, undefined, 'only safe properties')
})

test('a failing PostHog never throws into the caller', async () => {
  withKey()
  const stub = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('down')
  }) as typeof fetch
  const warn = console.warn
  console.warn = () => {}
  try {
    analytics.track('message_sent', { distinctId: 'u1' })
    await analytics.flushAnalytics()
  } finally {
    globalThis.fetch = stub
    console.warn = warn
  }
})

// ---------------------------------------------------------------------------
// Sign-up, against the real auth

function call(path: string, body: unknown) {
  return auth.handler(
    new Request(`${env.API_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_URL[0]! },
      body: JSON.stringify(body),
    }),
  )
}

async function signUp(email: string, extra: object) {
  emails.push(email)
  const logged: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void logged.push(args.join(' '))
  try {
    const sentCode = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' })
    assert.equal(sentCode.status, 200, await sentCode.clone().text())
  } finally {
    console.log = log
  }
  const otp = logged.find((l) => l.startsWith(`sign-in code for ${email}: `))!.split(': ')[1]!
  const response = await call('/sign-in/email-otp', { email, otp, ...extra })
  assert.equal(response.status, 200, await response.clone().text())
  return prisma.user.findUniqueOrThrow({ where: { email } })
}

test(
  "a code's sign-up keeps where it came from, once, and sends signed_up without the address",
  { skip },
  async () => {
    withKey()
    const email = `signup-${run}@brigade.lol`
    const user = await signUp(email, {
      signupSource: {
        utm_source: 'hn',
        utm_campaign: 'launch',
        ref: 'news.ycombinator.com',
        lp: '/how-it-works',
      },
    })
    assert.deepEqual(user.attribution, {
      channel: 'hacker_news',
      source: 'hn',
      campaign: 'launch',
      referrer: 'news.ycombinator.com',
      landingPage: '/how-it-works',
      method: 'email_code',
    })
    await analytics.flushAnalytics()
    const signedUp = events().find((e) => e.event === 'signed_up')
    assert.ok(signedUp, 'signed_up sent')
    assert.equal(signedUp.distinct_id, user.id)
    assert.equal(signedUp.properties.$set_once.signup_channel, 'hacker_news')
    assert.equal(signedUp.properties.$set_once.signup_method, 'email_code')
    assert.equal(signedUp.properties.$set.internal, true)
    assert.ok(!JSON.stringify(sent).includes(email), 'the address is never sent')

    // Set once: a later record keeps the first, and sends nothing.
    sent.length = 0
    await analytics.recordSignup(user, {
      path: '/sign-in/email-otp',
      body: { signupSource: { utm_source: 'x' } },
    })
    const again = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal((again.attribution as { channel: string }).channel, 'hacker_news')
    await analytics.flushAnalytics()
    assert.equal(events().filter((e) => e.event === 'signed_up').length, 0)
  },
)

test(
  'a sign-up with nothing to say is direct; signing in again changes nothing',
  { skip },
  async () => {
    const email = `direct-${run}@example.com`
    const user = await signUp(email, {})
    assert.equal((user.attribution as { channel: string }).channel, 'direct')
    const second = await signUp(email, { signupSource: { utm_source: 'x' } })
    assert.equal((second.attribution as { channel: string }).channel, 'direct')
  },
)

test("a person's first event of a kind says first, the next ones do not", { skip }, async () => {
  withKey()
  const email = `first-${run}@example.com`
  const user = await signUp(email, {})
  const person = { userId: user.id, internal: false }
  const scope = { organizationId: 'o', workspaceId: 'w' }
  await analytics.trackFor(person, 'turn_completed', scope, { outcome: 'done' })
  await analytics.trackFor(person, 'turn_completed', scope, { outcome: 'done' })
  await analytics.trackFor(person, 'thread_interrupted', scope)
  await analytics.flushAnalytics()
  const turns = events().filter((e) => e.event === 'turn_completed')
  assert.deepEqual(
    turns.map((e) => e.properties.first),
    [true, false],
  )
  assert.equal(events().find((e) => e.event === 'thread_interrupted')!.properties.first, undefined)
})
