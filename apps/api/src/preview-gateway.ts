// A preview's address on the previews' own site (apps/preview-gateway): https://<id>.brigade.surf
// in front of its address at the provider, with the provider's token added there. Safari,
// and every browser on an iPhone, drops the provider's token cookie in the dashboard's
// frame (another site): the provider's address stayed white there.

type Hosted = { origin: string; url: string }

type Gateway = { url: string; secret: string }

// Registered addresses: the provider gives the same address and token each time, and the
// gateway the same address for them.
const registered = new Map<string, string>()

/**
 * The address people open for a port the provider hosts: the gateway's when it has one,
 * else the provider's. A gateway that does not answer leaves the provider's: it works
 * everywhere but in Safari's frame.
 */
export async function throughGateway(
  hosted: Hosted,
  gateway: Gateway | null,
  request: typeof fetch = fetch,
): Promise<Hosted> {
  if (!gateway) return hosted
  let origin = registered.get(hosted.url)
  if (!origin) {
    try {
      const response = await request(new URL('/routes', gateway.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${gateway.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: hosted.url }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      origin = ((await response.json()) as { origin: string }).origin
      registered.set(hosted.url, origin)
    } catch (error) {
      console.warn(`the preview gateway did not register ${hosted.origin}: ${String(error)}`)
      return hosted
    }
  }
  // The id in its address lets people in: no token in it.
  return { origin, url: origin }
}
