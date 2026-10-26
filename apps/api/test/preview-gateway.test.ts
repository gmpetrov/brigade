import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessToken, forgetThread, previewEnded, throughGateway } from '../src/preview-gateway.js'

const gateway = { url: 'https://brigade.surf', secret: 'x'.repeat(32) }
const ID = 'abcdefghijklmnopqrstuvwxyz'

test('the access token is the one the gateway checks (apps/preview-gateway/test)', () => {
  assert.equal(
    accessToken('s3cret', 'a'.repeat(26), 2_000_000_000),
    '2000000000.d35xp4hezsfqynylnome5ps6ikrbirw5',
  )
})

test("the gateway's address for the thread, registered each time, with an access token for a few minutes", async () => {
  const hosted = { origin: 'https://box-2.on.boat.dev', url: 'https://box-2.on.boat.dev?_token=t' }
  const calls: Request[] = []
  const request = (async (input: URL, init: RequestInit) => {
    calls.push(new Request(input, init))
    return Response.json({ origin: `https://${ID}.brigade.surf` })
  }) as typeof fetch
  const through = await throughGateway(hosted, gateway, 'thread-1', request)
  assert.equal(through!.origin, `https://${ID}.brigade.surf`)
  const url = new URL(through!.url)
  assert.equal(url.origin, through!.origin)
  assert.equal(url.searchParams.has('_token'), false)
  const token = url.searchParams.get('_brigade')!
  const expires = Number(token.split('.')[0])
  const now = Date.now() / 1000
  assert.ok(expires > now + 240 && expires <= now + 300 + 1)
  assert.equal(token, accessToken(gateway.secret, ID, expires))

  await throughGateway(hosted, gateway, 'thread-1', request)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.url, 'https://brigade.surf/routes')
  assert.equal(calls[0]!.headers.get('authorization'), `Bearer ${gateway.secret}`)
  assert.deepEqual(await calls[0]!.json(), { url: hosted.url, thread: 'thread-1' })
})

test('a gateway that fails gives no address: never the provider’s token', async () => {
  const hosted = { origin: 'https://box-3.on.boat.dev', url: 'https://box-3.on.boat.dev?_token=t' }
  const down = (async () => new Response('nope', { status: 500 })) as typeof fetch
  assert.equal(await throughGateway(hosted, gateway, 'thread-1', down), null)
})

test("forgetting a thread's preview: tried again when the gateway fails, done when it answers", async () => {
  const calls: Request[] = []
  const answers = [500, 204]
  const request = (async (input: URL, init: RequestInit) => {
    calls.push(new Request(input, init))
    return new Response(null, { status: answers.shift() })
  }) as typeof fetch
  await forgetThread(gateway, 'thread-1', request, async () => {})
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.method, 'DELETE')
  assert.equal(calls[1]!.url, 'https://brigade.surf/routes')
  assert.deepEqual(await calls[1]!.json(), { thread: 'thread-1' })

  // A gateway from before routes per thread: nothing to forget.
  let old = 0
  await forgetThread(
    gateway,
    'thread-1',
    (async () => {
      old++
      return new Response('Not found', { status: 404 })
    }) as typeof fetch,
    async () => {},
  )
  assert.equal(old, 1)

  // Down: three tries, then it gives up without throwing.
  let tries = 0
  await forgetThread(
    gateway,
    'thread-1',
    (async () => {
      tries++
      throw new Error('offline')
    }) as typeof fetch,
    async () => {},
  )
  assert.equal(tries, 3)
})

test('a preview ends for good when it stops or fails, not when the next one replaces it', () => {
  const changed = (status: string, reason?: string) => ({
    event: {
      type: 'preview.changed',
      at: new Date().toISOString(),
      previewId: 'p',
      status,
      command: 'pnpm dev',
      cwd: '.',
      port: 3000,
      ports: [],
      ...(reason ? { reason } : {}),
    },
  })
  assert.equal(previewEnded([changed('stopped', 'Stopped by the teammate')]), true)
  assert.equal(previewEnded([changed('failed', 'It crashed')]), true)
  assert.equal(previewEnded([changed('stopped', 'Replaced by a new preview')]), false)
  assert.equal(previewEnded([changed('running')]), false)
  // Stopped, then started again within the same events: it runs.
  assert.equal(
    previewEnded([changed('stopped', 'Stopped by the teammate'), changed('starting')]),
    false,
  )
  assert.equal(previewEnded([{ event: { type: 'message.user' } }]), false)
})
