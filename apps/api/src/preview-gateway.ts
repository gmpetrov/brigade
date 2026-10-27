// A thread's preview on the previews' own site (apps/preview-gateway): https://<id>.brigade.surf
// in front of its address at the provider, with the provider's token added there. Safari,
// and every browser on an iPhone, drops the provider's token cookie in the dashboard's
// frame (another site): the provider's address stayed white there.
//
// The id is the thread's (with the provider's address), and does not let anyone in: the
// address handed out carries an access token for a few minutes, which the gateway trades
// for a cookie of its own (apps/preview-gateway/src/access.ts).
import { createHmac } from 'node:crypto'
import { PREVIEW_REPLACED, PreviewInfo } from '@brigade/contracts'

type Hosted = { origin: string; url: string }

type Gateway = { url: string; secret: string }

/** The access token's name in the address, and how long it lets someone in. */
export const ACCESS_PARAM = '_brigade'
export const ACCESS_SECONDS = 5 * 60

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array) {
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

/**
 * An access token for a preview's id, until `expires` (seconds): <expires>.<mac>, as the
 * gateway checks it. Its tests hold the same example.
 */
export function accessToken(secret: string, id: string, expires: number) {
  const mac = createHmac('sha256', secret).update(['access', id, String(expires)].join('\n'))
  return `${expires}.${base32(mac.digest()).slice(0, 32)}`
}

/**
 * The address people open for a thread's port the provider hosts: the gateway's, with an
 * access token (url), and without (origin, the app's own address). The thread's preview
 * is registered again each time: the gateway forgets it when it stops, and keeps one
 * thread per address at the provider. Null when the gateway does not answer.
 */
export async function throughGateway(
  hosted: Hosted,
  gateway: Gateway,
  thread: string,
  request: typeof fetch = fetch,
): Promise<Hosted | null> {
  let origin: string
  try {
    const response = await request(new URL('/routes', gateway.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: hosted.url, thread }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    origin = ((await response.json()) as { origin: string }).origin
  } catch (error) {
    console.warn(`the preview gateway did not register ${hosted.origin}: ${String(error)}`)
    return null
  }
  const id = new URL(origin).hostname.split('.')[0]!
  const url = new URL(origin)
  url.searchParams.set(
    ACCESS_PARAM,
    accessToken(gateway.secret, id, Math.floor(Date.now() / 1000) + ACCESS_SECONDS),
  )
  return { origin, url: url.href }
}

/**
 * The gateway forgets a thread's preview (it stopped, or the thread was deleted): its
 * address stops working, and the cookies made for it with it. Tried three times; should all
 * fail, its address leads nowhere once the preview's port closed, and the next preview at
 * that address at the provider, of any thread, drops it.
 */
export async function forgetThread(
  gateway: Gateway,
  thread: string,
  request: typeof fetch = fetch,
  pause = (ms: number) => new Promise((done) => setTimeout(done, ms)),
) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await request(new URL('/routes', gateway.url), {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${gateway.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ thread }),
        signal: AbortSignal.timeout(10_000),
      })
      // A gateway from before routes per thread has no such call, and nothing to forget.
      if (response.ok || response.status === 404) return
      throw new Error(`${response.status} ${await response.text()}`)
    } catch (error) {
      if (attempt === 3) {
        console.warn(`the preview gateway did not forget thread ${thread}: ${String(error)}`)
        return
      }
      await pause(attempt * 2_000)
    }
  }
}

/**
 * Whether a thread's new events end its preview for good: stopped or failed, and not to be
 * replaced by the next one (which registers the thread's address again, and may already have).
 */
export function previewEnded(events: { event: { type: string } }[]) {
  const last = events.findLast((e) => e.event.type === 'preview.changed')
  const preview = last ? PreviewInfo.safeParse(last.event) : null
  return (
    !!preview?.success &&
    (preview.data.status === 'stopped' || preview.data.status === 'failed') &&
    preview.data.reason !== PREVIEW_REPLACED
  )
}

/**
 * What a person opens for a preview on a member's machine: the thread's own name under its
 * localhost, as the runner says (its cookies apart from other threads'), else localhost
 * itself (runners before it). Nothing but a loopback name on the proxy's port is taken.
 */
export function localPreviewUrl(origin: string | undefined, port: number) {
  const named = origin?.match(/^http:\/\/([a-z0-9-]{1,63})\.localhost:(\d{1,5})$/)
  return named && Number(named[2]) === port
    ? `http://${named[1]}.localhost:${port}`
    : `http://localhost:${port}`
}
