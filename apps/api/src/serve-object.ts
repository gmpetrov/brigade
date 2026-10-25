// A file of the bucket served through the API, as it streams: never held whole, ranges answered
// (a video plays by ranges, and Safari plays none without them) from what the bucket holds now.
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamObject, streamRange } from './bucket.js'

/** One range, as the API answers them: another form (several ranges) is refused. */
const ONE_RANGE = /^bytes=(\d*)-(\d*)$/

export async function serveObject(c: Context, key: string, headers: Record<string, string>) {
  const missing = () => new HTTPException(404, { message: 'The file is missing from storage' })
  const all = { ...headers, 'accept-ranges': 'bytes' }
  const asked = c.req.header('range')?.trim()
  if (asked) {
    const match = ONE_RANGE.exec(asked)
    if (!match || (!match[1] && !match[2])) return c.body(null, 416, all)
    const part = await streamRange(key, asked)
    if (!part) throw missing()
    if (part.status === 416)
      return c.body(null, 416, {
        ...all,
        ...(part.size !== null ? { 'content-range': `bytes */${part.size}` } : {}),
      })
    return c.body(part.body, 206, { ...all, 'content-range': part.contentRange })
  }
  const body = await streamObject(key)
  if (!body) throw missing()
  return c.body(body, 200, all)
}

/** The first `max` bytes of a file (fewer if it is shorter), for a look at it. */
export async function headOf(key: string, max: number) {
  const part = await streamRange(key, `bytes=0-${max - 1}`)
  if (!part) throw new HTTPException(404, { message: 'The file is missing from storage' })
  // Past the end of an empty file.
  if (part.status === 416) return new Uint8Array()
  return new Uint8Array(await new Response(part.body).arrayBuffer())
}
