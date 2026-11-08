// Request bodies made of text and files that stream from the bucket: a file sent to an App
// (an email's attachments, a Drive upload) is never held whole in the API's memory, which a
// workspace's hub object shares with others (docs/workspace-hubs-plan.md).

/**
 * A body of exactly `length` bytes, sent with that length rather than in chunks: Workers take it
 * from a FixedLengthStream, Node from the header (as platform/*.ts fixedLength, without their
 * imports: connectors use this).
 */
function fixedLength(body: ReadableStream<Uint8Array>, length: number) {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream })
    .FixedLengthStream
  return {
    body: Fixed ? body.pipeThrough(new Fixed(length)) : body,
    headers: { 'content-length': String(length) },
  }
}

/** One part of a body: text, or a file's bytes as they arrive, opened when the body gets to it. */
export type BodyPart =
  string | { size: number; open: () => Promise<ReadableStream<Uint8Array>>; base64?: boolean }

/** Characters of base64 a line holds in a MIME part (RFC 2045), lines ending in CRLF. */
const LINE = 76

/** The length of `size` bytes as base64 in lines of 76 characters, without a CRLF after the last. */
export function base64LinesLength(size: number) {
  const chars = 4 * Math.ceil(size / 3)
  const lines = Math.ceil(chars / LINE)
  return chars + 2 * Math.max(lines - 1, 0)
}

/** Bytes as base64 in lines of 76 characters joined by CRLF, as they arrive. */
export function base64Lines(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let rest = new Uint8Array(0)
  // Characters on the current line.
  let column = 0
  const encoder = new TextEncoder()
  const lines = (chars: string) => {
    let out = ''
    for (let i = 0; i < chars.length;) {
      if (column === LINE) {
        out += '\r\n'
        column = 0
      }
      const take = Math.min(LINE - column, chars.length - i)
      out += chars.slice(i, i + take)
      column += take
      i += take
    }
    return encoder.encode(out)
  }
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const all = new Uint8Array(rest.length + chunk.length)
        all.set(rest)
        all.set(chunk, rest.length)
        const whole = all.length - (all.length % 3)
        rest = all.slice(whole)
        if (whole) controller.enqueue(lines(Buffer.from(all.subarray(0, whole)).toString('base64')))
      },
      flush(controller) {
        if (rest.length) controller.enqueue(lines(Buffer.from(rest).toString('base64')))
      },
    }),
  )
}

/** How many bytes the parts make. */
export function partsLength(parts: BodyPart[]) {
  const encoder = new TextEncoder()
  return parts.reduce(
    (sum, part) =>
      sum +
      (typeof part === 'string'
        ? encoder.encode(part).byteLength
        : part.base64
          ? base64LinesLength(part.size)
          : part.size),
    0,
  )
}

/**
 * The parts one after the other, each file opened only when the body reaches it, and checked to
 * be as long as it said: a body shorter or longer than its length is refused on the way.
 */
export function partsStream(parts: BodyPart[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let read = 0
  let expected = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read()
          if (!done) {
            read += value.byteLength
            if (read > expected) throw new Error('A file is longer than it said')
            controller.enqueue(value)
            return
          }
          if (read !== expected) throw new Error('A file is shorter than it said')
          reader = undefined
        }
        const part = parts[index++]
        if (part === undefined) return controller.close()
        if (typeof part === 'string') {
          if (part) controller.enqueue(encoder.encode(part))
          if (part) return
          continue
        }
        const opened = await part.open()
        reader = (part.base64 ? base64Lines(opened) : opened).getReader()
        read = 0
        expected = part.base64 ? base64LinesLength(part.size) : part.size
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason)
    },
  })
}

/**
 * Send the parts as one request body of a known length, through a connection's fetch. Refused
 * once for an expired token (401), it goes again with the files opened anew: a stream is sent
 * only once (authorisedFetch).
 */
export async function sendParts(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: { method: string; headers: Record<string, string> },
  parts: BodyPart[],
) {
  const length = partsLength(parts)
  const send = () => {
    const sized = fixedLength(partsStream(parts), length)
    return fetch(url, {
      method: init.method,
      headers: { ...init.headers, ...sized.headers },
      body: sized.body,
      duplex: 'half',
    } as RequestInit)
  }
  const response = await send()
  if (response.status !== 401) return response
  await response.body?.cancel()
  return send()
}
