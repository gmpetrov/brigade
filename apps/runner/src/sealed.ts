// What a cloud computer backs up goes to Brigade's bucket encrypted, with a key the API derives
// for its workspace (GET /runner/computer/backup-key): the bucket alone never holds a thread's
// files, a crontab or a browser's cookies readable. AES-256-GCM, file to file, streamed:
//   "BGE1" | iv (12 bytes) | ciphertext | tag (16 bytes)
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const MAGIC = Buffer.from('BGE1')
const IV = 12
const TAG = 16

/** Encrypt `from` into `to`; resolves to the size of `to`. */
export async function seal(from: string, to: string, key: Buffer) {
  const iv = randomBytes(IV)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const out = createWriteStream(to, { mode: 0o600 })
  out.write(Buffer.concat([MAGIC, iv]))
  await pipeline(createReadStream(from), cipher, out, { end: false })
  await new Promise<void>((resolve, reject) =>
    out.end(cipher.getAuthTag(), (error?: Error | null) => (error ? reject(error) : resolve())),
  )
  return (await stat(to)).size
}

/** Decrypt what seal wrote in `from` into `to`; throws when it is not that, or was changed. */
export async function unseal(from: string, to: string, key: Buffer) {
  const { size } = await stat(from)
  if (size < MAGIC.length + IV + TAG) throw new Error('Not a Brigade backup')
  const handle = await open(from, 'r')
  const head = Buffer.alloc(MAGIC.length + IV)
  const tag = Buffer.alloc(TAG)
  try {
    await handle.read(head, 0, head.length, 0)
    await handle.read(tag, 0, TAG, size - TAG)
  } finally {
    await handle.close()
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Brigade backup')
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length))
  decipher.setAuthTag(tag)
  // The tag is checked at the end: a backup that does not match throws then, and the caller
  // removes what was written of it.
  const body = size - TAG - 1 >= head.length
  await pipeline(
    body ? createReadStream(from, { start: head.length, end: size - TAG - 1 }) : Readable.from([]),
    decipher,
    createWriteStream(to, { mode: 0o600 }),
  )
}
