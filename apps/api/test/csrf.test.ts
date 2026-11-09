import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { apiCsrf } from '../src/cors.js'

// A write a browser sends with the session cookie, in a form-like body, must come from the
// dashboard (src/cors.ts): the kind of request another page can send without a CORS preflight.
const app = new Hono()
app.use('/api/*', apiCsrf(['https://www.brigade.lol']))
app.all('/api/*', (c) => c.text('ok'))

const send = (headers: Record<string, string>, method = 'POST') =>
  app.request('https://api.brigade.lol/api/thing', {
    method,
    headers,
    body: method === 'GET' ? undefined : 'x',
  })

test("a form post from another site with the member's cookie is refused", async () => {
  for (const type of [
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
  ])
    assert.equal(
      (await send({ cookie: 's=1', 'content-type': type, origin: 'https://designs.brigade.lol' }))
        .status,
      403,
      type,
    )
  assert.equal((await send({ cookie: 's=1', 'content-type': 'text/plain' })).status, 403)
})

test('the dashboard, reads, JSON and requests without a cookie go through', async () => {
  const dashboard = {
    cookie: 's=1',
    'content-type': 'multipart/form-data; boundary=x',
    origin: 'https://www.brigade.lol',
  }
  assert.equal((await send(dashboard)).status, 200)
  assert.equal((await send({ cookie: 's=1', origin: 'https://evil.example' }, 'GET')).status, 200)
  assert.equal(
    (
      await send({
        cookie: 's=1',
        'content-type': 'application/json',
        origin: 'https://evil.example',
      })
    ).status,
    200,
  )
  assert.equal((await send({ 'content-type': 'text/plain' })).status, 200)
})
