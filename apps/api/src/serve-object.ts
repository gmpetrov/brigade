// A file of the bucket served through the API, as it streams: never held whole, ranges answered
// (a video plays by ranges, and Safari plays none without them).
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamObject, streamRange } from './bucket.js'
import { byteRange } from './byte-range.js'

export async function serveObject(
  c: Context,
  key: string,
  size: number,
  headers: Record<string, string>,
) {
  const missing = () => new HTTPException(404, { message: 'The file is missing from storage' })
  const all = { ...headers, 'accept-ranges': 'bytes' }
  const asked = c.req.header('range')
  if (asked && size > 0) {
    const range = byteRange(asked, size)
    if (!range) return c.body(null, 416, { ...all, 'content-range': `bytes */${size}` })
    const [start, end] = range
    const body = await streamRange(key, start, end)
    if (!body) throw missing()
    return c.body(body, 206, { ...all, 'content-range': `bytes ${start}-${end}/${size}` })
  }
  // Whole, by the stream: whatever its recorded size (a document's text may have moved on).
  const body = await streamObject(key)
  if (!body) throw missing()
  return c.body(body, 200, all)
}

/** The first `max` bytes of a file, for a look at it (a text's beginning). */
export async function headOf(key: string, size: number, max: number) {
  if (size === 0) return new Uint8Array()
  const body = await streamRange(key, 0, Math.min(size, max) - 1)
  if (!body) throw new HTTPException(404, { message: 'The file is missing from storage' })
  return new Uint8Array(await new Response(body).arrayBuffer())
}
