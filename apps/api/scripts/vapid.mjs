// A new VAPID key pair for web push, as lines for apps/api/.env.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
console.log(`VAPID_PUBLIC_KEY=${Buffer.from(raw).toString('base64url')}`)
console.log(`VAPID_PRIVATE_KEY=${d}`)
