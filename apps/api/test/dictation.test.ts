import assert from 'node:assert/strict'
import { test } from 'node:test'

// Dictation (src/dictation.ts): a recording goes to Whisper Large v3 Turbo, through OpenRouter or
// Groq, and its words come back. Neither is reached here: a stand-in fetch reads what would be
// sent. Billing is off (no STRIPE_SECRET_KEY), so a provider's key alone makes it available.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
delete process.env.STRIPE_SECRET_KEY
process.env.OPENROUTER_API_KEY = 'sk-or-test-never-sent'
delete process.env.GROQ_API_KEY
delete process.env.DICTATION_MODEL

const { env } = await import('../src/config.js')
const dictation = await import('../src/dictation.js')
const { HTTPException } = await import('hono/http-exception')

const openrouter = { ...dictation.PROVIDERS.openrouter, key: 'sk-or-key' }
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

test('sends the recording to Whisper Large v3 Turbo on OpenRouter, named for its format, and trims the words', async () => {
  const { sent, fetcher } = groq(() => json(200, { text: '  Bonjour Riley, peux-tu regarder ?  ' }))
  const result = await dictation.transcribe(audio(), { to: openrouter, fetcher })
  assert.deepEqual(result, { text: 'Bonjour Riley, peux-tu regarder ?' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.url, 'https://openrouter.ai/api/v1/audio/transcriptions')
  assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, 'Bearer sk-or-key')
  const form = sent[0]!.init.body as FormData
  assert.equal(form.get('model'), 'openai/whisper-large-v3-turbo')
  const file = form.get('file') as File
  assert.equal(file.name, 'dictation.webm')
  assert.equal(file.type, 'audio/webm')
  assert.equal(file.size, 128)
})

test('names Safari’s recordings for the provider too, and refuses a type it does not take', async () => {
  assert.equal(dictation.audioName('audio/mp4'), 'dictation.mp4')
  assert.equal(dictation.audioName('audio/ogg;codecs=opus'), 'dictation.ogg')
  assert.equal(dictation.audioName('application/pdf'), null)
  const { sent, fetcher } = groq(() => json(200, { text: 'x' }))
  await refused(dictation.transcribe(audio('application/pdf'), { to: openrouter, fetcher }), 415)
  await refused(dictation.transcribe(audio('audio/webm', 0), { to: openrouter, fetcher }), 400)
  await refused(
    dictation.transcribe(audio('audio/webm', 20 * 1024 * 1024 + 1), { to: openrouter, fetcher }),
    413,
  )
  assert.equal(sent.length, 0, 'nothing reaches Groq')
})

test('The provider’s refusals become the person’s words, never its own message', async () => {
  const busy = groq(() => json(429, { error: { message: 'Rate limit reached for gsk_…' } }))
  await refused(dictation.transcribe(audio(), { to: openrouter, fetcher: busy.fetcher }), 429)
  const bad = groq(() => json(400, { error: { message: 'could not process file' } }))
  await assert.rejects(
    dictation.transcribe(audio(), { to: openrouter, fetcher: bad.fetcher }),
    (e: unknown) =>
      e instanceof HTTPException &&
      e.status === 422 &&
      e.message === 'This recording could not be transcribed',
  )
  const down = groq(() => json(503, {}))
  await refused(dictation.transcribe(audio(), { to: openrouter, fetcher: down.fetcher }), 502)
  const odd = groq(() => json(200, { nothing: true }))
  await refused(dictation.transcribe(audio(), { to: openrouter, fetcher: odd.fetcher }), 502)
  const unreachable = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  await refused(dictation.transcribe(audio(), { to: openrouter, fetcher: unreachable }), 502)
})

test('OpenRouter for now, Groq’s own API first once it has a key, another model by name', () => {
  assert.deepEqual(dictation.transcriber(), {
    url: 'https://openrouter.ai/api/v1/audio/transcriptions',
    model: 'openai/whisper-large-v3-turbo',
    key: 'sk-or-test-never-sent',
  })
  env.GROQ_API_KEY = 'gsk_test'
  try {
    assert.deepEqual(dictation.transcriber(), {
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo',
      key: 'gsk_test',
    })
  } finally {
    env.GROQ_API_KEY = undefined
  }
  env.DICTATION_MODEL = 'x-ai/grok-stt-1.0'
  try {
    assert.equal(dictation.transcriber()?.model, 'x-ai/grok-stt-1.0')
  } finally {
    env.DICTATION_MODEL = undefined
  }
})

test('available with a provider’s key while billing is off; no button without one', async () => {
  assert.deepEqual(await dictation.dictationStatus('ws-any'), { available: true })
  await dictation.requireDictation('ws-any')
  const key = env.OPENROUTER_API_KEY
  env.OPENROUTER_API_KEY = undefined
  try {
    assert.deepEqual(await dictation.dictationStatus('ws-any'), {
      available: false,
      reason: 'off',
    })
    await refused(dictation.requireDictation('ws-any'), 404)
  } finally {
    env.OPENROUTER_API_KEY = key
  }
})
