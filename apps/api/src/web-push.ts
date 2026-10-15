// Web Push, on WebCrypto alone so it runs on Node and on Workers: the payload
// encrypted for the browser (RFC 8291, aes128gcm) and the server identified to
// the push service by a VAPID token (RFC 8292).
import type { webcrypto } from 'node:crypto'

const encoder = new TextEncoder()

type CryptoKey = webcrypto.CryptoKey
type CryptoKeyPair = webcrypto.CryptoKeyPair
type JsonWebKey = webcrypto.JsonWebKey

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

export const fromBase64Url = (text: string) => {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A P-256 private key as JWK, from its raw 32-byte scalar and 65-byte uncompressed public key. */
const privateJwk = (d: Uint8Array, publicKey: Uint8Array): JsonWebKey => ({
  kty: 'EC',
  crv: 'P-256',
  d: toBase64Url(d),
  x: toBase64Url(publicKey.slice(1, 33)),
  y: toBase64Url(publicKey.slice(33, 65)),
  ext: true,
})

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/** Where a browser receives pushes, as PushSubscription.toJSON() gives it. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string }

/**
 * The body of a push for one subscription. `fixed` is for tests only: the
 * server's key pair and the salt, which are otherwise new for every message.
 */
export async function encryptPayload(
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  payload: Uint8Array,
  fixed?: { privateKey: Uint8Array; publicKey: Uint8Array; salt: Uint8Array },
) {
  const uaPublic = fromBase64Url(target.p256dh)
  const authSecret = fromBase64Url(target.auth)
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const

  let asPrivate: CryptoKey
  let asPublic: Uint8Array
  if (fixed) {
    asPrivate = await crypto.subtle.importKey(
      'jwk',
      privateJwk(fixed.privateKey, fixed.publicKey),
      ecdh,
      false,
      ['deriveBits'],
    )
    asPublic = fixed.publicKey
  } else {
    const pair = (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair
    asPrivate = pair.privateKey
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, ecdh, false, [])
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256),
  )

  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic),
    32,
  )
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // One record: the payload, then the last-record delimiter.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(payload, new Uint8Array([2])),
    ),
  )
  const recordSize = new Uint8Array(4)
  new DataView(recordSize.buffer).setUint32(0, 4096)
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}

/** Brigade's VAPID keys: the public one browsers subscribe with, both base64url. */
export type Vapid = { publicKey: string; privateKey: string; subject: string }

/** A VAPID token for the push service at `endpoint`'s origin, valid 12 hours. */
export async function vapidAuthorization(vapid: Vapid, endpoint: string) {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  )
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk(fromBase64Url(vapid.privateKey), fromBase64Url(vapid.publicKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  // WebCrypto signs as r || s, which is what a JWS wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      encoder.encode(`${header}.${claims}`),
    ),
  )
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${vapid.publicKey}`
}

/** A new pair of VAPID keys, for setup. */
export async function generateVapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  )
  return { publicKey: toBase64Url(publicKey), privateKey: jwk.d! }
}

export type PushResult = 'sent' | 'gone' | 'failed'

/**
 * Send one message. `topic` replaces a message with the same topic the push
 * service still holds for an offline device (letters, digits, - and _; at most 32).
 * Gone: the browser unsubscribed or the subscription expired; forget it.
 */
export async function sendPush(
  vapid: Vapid,
  target: PushTarget,
  message: unknown,
  options: { topic?: string; ttlSeconds?: number; urgency?: 'normal' | 'high' } = {},
): Promise<PushResult> {
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(message)))
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization(vapid, target.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(options.ttlSeconds ?? 24 * 60 * 60),
      urgency: options.urgency ?? 'normal',
      ...(options.topic && { topic: options.topic }),
    },
    body,
  })
  if (response.ok) return 'sent'
  if (response.status === 404 || response.status === 410) return 'gone'
  console.warn(
    `push to ${new URL(target.endpoint).host} failed: ${response.status} ${await response.text().catch(() => '')}`,
  )
  return 'failed'
}
