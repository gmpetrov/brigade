import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { test } from 'node:test'
import {
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  toBase64Url,
  topicOf,
  vapidAuthorization,
} from '../src/web-push.js'

test('encrypts as RFC 8291 Appendix A does', async () => {
  const body = await encryptPayload(
    {
      p256dh:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
    new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    {
      privateKey: fromBase64Url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      publicKey: fromBase64Url(
        'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      ),
      salt: fromBase64Url('DGv6ra1nlYgDCS1FRnbzlw'),
    },
  )
  assert.equal(
    toBase64Url(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  )
})

test('a VAPID token is signed by the public key it names, for the push service', async () => {
  const keys = await generateVapidKeys()
  const vapid = { ...keys, subject: 'mailto:ops@example.com' }
  const header = await vapidAuthorization(vapid, 'https://push.example.net/send/abc')
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!
  assert.equal(k, keys.publicKey)
  const [head, claims, signature] = token!.split('.')
  const raw = fromBase64Url(keys.publicKey)
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(raw.slice(1, 33)),
      y: toBase64Url(raw.slice(33)),
    },
    format: 'jwk',
  })
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${head}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      fromBase64Url(signature!),
    ),
  )
  const payload = JSON.parse(Buffer.from(fromBase64Url(claims!)).toString())
  assert.equal(payload.aud, 'https://push.example.net')
  assert.equal(payload.sub, 'mailto:ops@example.com')
})

test('a topic is 32 characters that decode as base64url, the same for the same key', async () => {
  // A thread id: 25 characters, which no base64url encoding has. Apple refused it as is.
  for (const key of ['cmvdx6pwh001ipsp77ih0dlo2', 'brigade', 'brigade-test', 'é · x']) {
    const topic = await topicOf(key)
    assert.match(topic, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(fromBase64Url(topic).length, 24)
    assert.equal(await topicOf(key), topic)
  }
  assert.notEqual(await topicOf('a'), await topicOf('b'))
})
