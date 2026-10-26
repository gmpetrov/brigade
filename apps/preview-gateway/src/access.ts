// What lets a person into a preview here, all keyed with the secret the API shares:
//
// - An access token in the address (?_brigade=), from the API to whoever may see the
//   thread, for a few minutes: <expiry in seconds>.<mac>. The API makes the same
//   (apps/api/src/preview-gateway.ts); the tests of both hold the same example.
// - The cookie the gateway trades it for (__Host-brigade), for this host only, for the
//   preview's run (its route's nonce) and 12 hours at most.
// - Where the browser drops that cookie (Safari, and so every browser on an iPhone, in the
//   dashboard's frame on another site), a grant in the host itself: <id>-<grant>, for the
//   same run and as long. Only the gateway makes one, and only for a valid access token.

/** The access token's name in the address. */
export const ACCESS_PARAM = '_brigade'
/** Set on the redirect that tries the cookie: back without it, the browser dropped it. */
export const TRIED_PARAM = '_brigade_cookie'
/** Host-only, Secure, path / (the __Host- prefix): no other preview can set or toss it. */
export const ACCESS_COOKIE = '__Host-brigade'
/** How long the cookie and a grant last, at most: the preview's run ends them sooner. */
export const ACCESS_SECONDS = 12 * 60 * 60

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32(bytes: Uint8Array) {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** HMAC-SHA256 of the lines, in base32. */
export async function mac(secret: string, ...lines: string[]) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base32(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(lines.join('\n'))),
    ),
  )
}

/** Equal strings in a time that does not tell how much of them matched. */
export function same(a: string, b: string) {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const now = () => Math.floor(Date.now() / 1000)

/** <expiry>.<mac> of these lines, valid until the expiry. */
async function sealed(secret: string, kind: string, lines: string[], expires: number) {
  return `${expires}.${(await mac(secret, kind, ...lines, String(expires))).slice(0, 32)}`
}

async function unseal(secret: string, kind: string, lines: string[], value: string | null) {
  const match = /^(\d{1,12})\.([a-z2-7]{32})$/.exec(value ?? '')
  if (!match || Number(match[1]) <= now()) return false
  return same(value!, await sealed(secret, kind, lines, Number(match[1])))
}

/** The access token for a preview's id (the API makes these; here for the tests). */
export const accessToken = (secret: string, id: string, expires: number) =>
  sealed(secret, 'access', [id], expires)

export const validAccess = (secret: string, id: string, value: string | null) =>
  unseal(secret, 'access', [id], value)

/** The cookie's value for a run of the preview. */
export const accessCookie = (secret: string, id: string, nonce: string) =>
  sealed(secret, 'cookie', [id, nonce], now() + ACCESS_SECONDS)

export const validCookie = (secret: string, id: string, nonce: string, value: string | null) =>
  unseal(secret, 'cookie', [id, nonce], value)

/** The cookie in a request's Cookie header, if any. */
export function cookieOf(header: string | null, name = ACCESS_COOKIE) {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

// A grant fits in a DNS label after the id (26 + 1 + 36 = 63 characters): its expiry in 7
// base32 characters (35 bits), then 29 of the mac (145 bits).
const GRANT = /^([a-z2-7]{7})([a-z2-7]{29})$/

function expiryLabel(expires: number) {
  let out = ''
  for (let i = 6; i >= 0; i--) out += ALPHABET[Math.floor(expires / 32 ** i) % 32]
  return out
}

/** The host label of a grant for a run of the preview: <id>-<grant>. */
export async function grantLabel(secret: string, id: string, nonce: string, expires?: number) {
  const at = expires ?? now() + ACCESS_SECONDS
  return `${id}-${expiryLabel(at)}${(await mac(secret, 'grant', id, nonce, String(at))).slice(0, 29)}`
}

export async function validGrant(secret: string, id: string, nonce: string, grant: string) {
  const match = GRANT.exec(grant)
  if (!match) return false
  const expires = [...match[1]!].reduce((n, c) => n * 32 + ALPHABET.indexOf(c), 0)
  if (expires <= now()) return false
  return same(`${id}-${grant}`, await grantLabel(secret, id, nonce, expires))
}
