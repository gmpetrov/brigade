// A base64 field of a JSON answer, decoded as it arrives: Gmail sends an attachment as
// {"size": …, "data": "<base64url>"}, which is never held whole (src/connectors/gmail.ts).

/** Text before the field this long: the answer is not what was expected. */
const BEFORE_MAX = 64 * 1024

const QUOTE = 0x22
const COLON = 0x3a
const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d])

/** The bytes the base64 (or base64url) string `field` of a JSON object holds, as it arrives. */
export function jsonBase64Field(field: string): TransformStream<Uint8Array, Uint8Array> {
  const key = new TextEncoder().encode(`"${field}"`)
  let state: 'key' | 'colon' | 'value' | 'done' = 'key'
  let matched = 0
  let colon = false
  let before = 0
  // Base64 characters not yet decoded: fewer than four.
  let rest = ''
  const decode = (text: string) =>
    new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))

  return new TransformStream({
    transform(chunk, out) {
      let i = 0
      while (i < chunk.length) {
        if (state === 'done') return
        if (state === 'value') {
          let end = i
          while (end < chunk.length && chunk[end] !== QUOTE) end++
          const text = rest + Buffer.from(chunk.subarray(i, end)).toString('latin1')
          const whole = text.length - (text.length % 4)
          if (whole) out.enqueue(decode(text.slice(0, whole)))
          rest = text.slice(whole)
          i = end
          if (end < chunk.length) {
            if (rest) out.enqueue(decode(rest))
            rest = ''
            state = 'done'
          }
          continue
        }
        const b = chunk[i]!
        if (++before > BEFORE_MAX) throw new Error(`No "${field}" in the answer`)
        if (state === 'colon') {
          if (b === COLON && !colon) colon = true
          else if (b === QUOTE && colon) state = 'value'
          else if (!SPACE.has(b)) {
            // Not the field after all (the word as a value): look again from here.
            state = 'key'
            matched = 0
            continue
          }
          i++
          continue
        }
        if (b === key[matched]) matched++
        else matched = b === key[0] ? 1 : 0
        if (matched === key.length) {
          state = 'colon'
          colon = false
          matched = 0
        }
        i++
      }
    },
    flush() {
      if (state !== 'done') throw new Error(`No "${field}" in the answer`)
    },
  })
}
