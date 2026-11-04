import assert from 'node:assert/strict'
import { test } from 'node:test'

// Dictation (src/dictation.ts): a recording goes to Groq's Whisper Large v3 Turbo and its words
// come back. Groq is never reached here: a stand-in fetch reads what would be sent. Billing is
// off (no STRIPE_SECRET_KEY), so a Groq key alone makes dictation available.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
delete process.env.STRIPE_SECRET_KEY
process.env.GROQ_API_KEY = 'gsk_test_never_sent'

const { env } = await import('../src/config.js')
const dictation = await import('../src/dictation.js')
const { HTTPException } = await import('hono/http-exception')

const audio = (type = 'audio/webm;codecs=opus', bytes = 128) =>
  new Blob([new Uint8Array(bytes).fill(1)], { type })

type Sent = { url: string; init: RequestInit }
const groq = (reply: () => Response) => {
  const sent: Sent[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    return reply()
  }) as unknown as typeof fetch
  return { sent, fetcher }
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const refused = async (run: Promise<unknown>, status: number) => {
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof HTTPException)
    assert.equal(e.status, status)
    return true
  })
}

test('sends the recording to Whisper Large v3 Turbo, named for its format, and trims the words', async () => {
  const { sent, fetcher } = groq(() => json(200, { text: '  Bonjour Riley, peux-tu regarder ?  ' }))
  const result = await dictation.transcribe(audio(), { key: 'gsk_key', fetcher })
  assert.deepEqual(result, { text: 'Bonjour Riley, peux-tu regarder ?' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.url, 'https://api.groq.com/openai/v1/audio/transcriptions')
  assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, 'Bearer gsk_key')
  const form = sent[0]!.init.body as FormData
  assert.equal(form.get('model'), 'whisper-large-v3-turbo')
  const file = form.get('file') as File
  assert.equal(file.name, 'dictation.webm')
  assert.equal(file.type, 'audio/webm')
  assert.equal(file.size, 128)
})

test('names Safari’s recordings for Groq too, and refuses a type it does not take', async () => {
  assert.equal(dictation.audioName('audio/mp4'), 'dictation.mp4')
  assert.equal(dictation.audioName('audio/ogg;codecs=opus'), 'dictation.ogg')
  assert.equal(dictation.audioName('application/pdf'), null)
  const { sent, fetcher } = groq(() => json(200, { text: 'x' }))
  await refused(dictation.transcribe(audio('application/pdf'), { key: 'k', fetcher }), 415)
  await refused(dictation.transcribe(audio('audio/webm', 0), { key: 'k', fetcher }), 400)
  await refused(
    dictation.transcribe(audio('audio/webm', 20 * 1024 * 1024 + 1), { key: 'k', fetcher }),
    413,
  )
  assert.equal(sent.length, 0, 'nothing reaches Groq')
})

test('Groq’s refusals become the person’s words, never its own message', async () => {
  const busy = groq(() => json(429, { error: { message: 'Rate limit reached for gsk_…' } }))
  await refused(dictation.transcribe(audio(), { key: 'k', fetcher: busy.fetcher }), 429)
  const bad = groq(() => json(400, { error: { message: 'could not process file' } }))
  await assert.rejects(
    dictation.transcribe(audio(), { key: 'k', fetcher: bad.fetcher }),
    (e: unknown) =>
      e instanceof HTTPException &&
      e.status === 422 &&
      e.message === 'This recording could not be transcribed',
  )
  const down = groq(() => json(503, {}))
  await refused(dictation.transcribe(audio(), { key: 'k', fetcher: down.fetcher }), 502)
  const odd = groq(() => json(200, { nothing: true }))
  await refused(dictation.transcribe(audio(), { key: 'k', fetcher: odd.fetcher }), 502)
  const unreachable = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  await refused(dictation.transcribe(audio(), { key: 'k', fetcher: unreachable }), 502)
})

test('available with a Groq key while billing is off; no button without one', async () => {
  assert.deepEqual(await dictation.dictationStatus('ws-any'), { available: true })
  await dictation.requireDictation('ws-any')
  const key = env.GROQ_API_KEY
  env.GROQ_API_KEY = undefined
  try {
    assert.deepEqual(await dictation.dictationStatus('ws-any'), {
      available: false,
      reason: 'off',
    })
    await refused(dictation.requireDictation('ws-any'), 404)
  } finally {
    env.GROQ_API_KEY = key
  }
})
