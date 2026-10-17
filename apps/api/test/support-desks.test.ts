import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intercom, paragraphs } from '../src/connectors/intercom.js'
import { redact, type ConnectorContext } from '../src/connectors/types.js'
import { zendesk, zendeskBaseUrl } from '../src/connectors/zendesk.js'

/** A context that records each request and answers with the given bodies, in order. */
function fake(...answers: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const ctx = {
    callId: 'call-1',
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(answers.shift() ?? {}), { status: 200 })
    },
  } as unknown as ConnectorContext
  return { ctx, calls, body: (i: number) => JSON.parse(String(calls[i]!.init?.body)) }
}

test('every write that reaches a customer asks a person, and only those', () => {
  const always = Object.entries({ ...intercom.operations, ...zendesk.operations })
    .filter(([, o]) => o.approval === 'always')
    .map(([name]) => name)
  assert.deepEqual(always.sort(), ['intercom_reply', 'zendesk_reply'])
})

test('a Zendesk subdomain however it is typed', () => {
  assert.equal(zendeskBaseUrl('acme'), 'https://acme.zendesk.com')
  assert.equal(zendeskBaseUrl(' Acme.zendesk.com '), 'https://acme.zendesk.com')
  assert.equal(
    zendeskBaseUrl('https://acme.zendesk.com/agent/tickets/4'),
    'https://acme.zendesk.com',
  )
  assert.throws(() => zendeskBaseUrl('evil.com/x'))
  assert.throws(() => zendeskBaseUrl('a b'))
})

test("Zendesk's token goes as Basic auth on the agent's email", () => {
  const { authorization } = zendesk.key!.headers({ apiKey: 'tok', email: 'ada@acme.com' })
  assert.equal(authorization, `Basic ${Buffer.from('ada@acme.com/token:tok').toString('base64')}`)
  assert.equal(redact(`sent ${authorization}`), 'sent Basic [redacted]')
})

test('an Intercom reply is plain text, sent as the admin who made the token', async () => {
  assert.equal(
    paragraphs('Hi <b>Ada</b>\n\nThanks & bye'),
    '<p>Hi &lt;b&gt;Ada&lt;/b&gt;</p><p></p><p>Thanks &amp; bye</p>',
  )
  const { ctx, calls, body } = fake(
    { type: 'admin', id: '42', email: 'riley@acme.com', name: 'Riley' },
    { id: '7', state: 'open', source: { author: { type: 'user' }, body: 'Help' } },
  )
  const out = (await intercom.operations.intercom_reply!.run(ctx, {
    conversationId: '7',
    message: 'On it',
  })) as { repliedAs: string }
  assert.equal(calls[0]!.url, '/me')
  assert.equal(calls[1]!.url, '/conversations/7/reply')
  assert.deepEqual(body(1), {
    message_type: 'comment',
    type: 'admin',
    admin_id: '42',
    body: '<p>On it</p>',
  })
  assert.equal(out.repliedAs, 'riley@acme.com')
})

test("Intercom's search combines the filters given, and needs one", async () => {
  const one = fake({ conversations: [], total_count: 0 })
  await intercom.operations.intercom_search_conversations!.run(one.ctx, { limit: 5 })
  assert.deepEqual(one.body(0).query, { field: 'updated_at', operator: '>', value: 0 })
  const two = fake({ conversations: [], total_count: 0 })
  await intercom.operations.intercom_search_conversations!.run(two.ctx, {
    state: 'open',
    email: 'ada@example.com',
    limit: 5,
  })
  assert.deepEqual(two.body(0).query, {
    operator: 'AND',
    value: [
      { field: 'state', operator: '=', value: 'open' },
      { field: 'source.author.email', operator: '=', value: 'ada@example.com' },
    ],
  })
})

test('a Zendesk reply is a public comment, a note a private one', async () => {
  const ticket = { ticket: { id: 4, status: 'pending', tags: [] } }
  const reply = fake(ticket)
  await zendesk.operations.zendesk_reply!.run(reply.ctx, {
    ticketId: 4,
    message: 'Fixed',
    status: 'pending',
  })
  assert.equal(reply.calls[0]!.url, '/api/v2/tickets/4.json')
  assert.deepEqual(reply.body(0), {
    ticket: { comment: { body: 'Fixed', public: true }, status: 'pending' },
  })
  const note = fake(ticket)
  await zendesk.operations.zendesk_add_note!.run(note.ctx, { ticketId: 4, note: 'Refund?' })
  assert.deepEqual(note.body(0), { ticket: { comment: { body: 'Refund?', public: false } } })
})
