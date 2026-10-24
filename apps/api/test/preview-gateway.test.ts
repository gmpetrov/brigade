import assert from 'node:assert/strict'
import { test } from 'node:test'
import { throughGateway } from '../src/preview-gateway.js'

const gateway = { url: 'https://brigade.surf', secret: 'x'.repeat(32) }

test("without a gateway, the provider's address", async () => {
  const hosted = { origin: 'https://box-1.on.boat.dev', url: 'https://box-1.on.boat.dev?_token=t' }
  assert.deepEqual(await throughGateway(hosted, null), hosted)
})

test("the gateway's address, registered once, without the token", async () => {
  const hosted = { origin: 'https://box-2.on.boat.dev', url: 'https://box-2.on.boat.dev?_token=t' }
  const calls: Request[] = []
  const request = (async (input: URL, init: RequestInit) => {
    calls.push(new Request(input, init))
    return Response.json({ origin: 'https://abc.brigade.surf' })
  }) as typeof fetch
  const expected = { origin: 'https://abc.brigade.surf', url: 'https://abc.brigade.surf' }
  assert.deepEqual(await throughGateway(hosted, gateway, request), expected)
  assert.deepEqual(await throughGateway(hosted, gateway, request), expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://brigade.surf/routes')
  assert.equal(calls[0]!.headers.get('authorization'), `Bearer ${gateway.secret}`)
  assert.deepEqual(await calls[0]!.json(), { url: hosted.url })
})

test("a gateway that fails leaves the provider's address, and is asked again next time", async () => {
  const hosted = { origin: 'https://box-3.on.boat.dev', url: 'https://box-3.on.boat.dev?_token=t' }
  let calls = 0
  const down = (async () => {
    calls++
    return new Response('nope', { status: 500 })
  }) as typeof fetch
  assert.deepEqual(await throughGateway(hosted, gateway, down), hosted)
  assert.deepEqual(await throughGateway(hosted, gateway, down), hosted)
  assert.equal(calls, 2)
})
