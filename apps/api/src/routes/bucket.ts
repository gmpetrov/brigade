// The bucket's stand-in for uploads without R2 (development only: production refuses to
// start without R2): a client PUTs a file to the signed path uploadTarget gave, as it
// would to R2's signed URL, and its bytes stream to BUCKET_DIR. No session needed: the
// signature names the key, size and type, and expires.
//   PUT /api/bucket?key&size&type&expires&sig
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { localUploadAllowed, putLocalStream } from '../bucket.js'

export const localBucket = new Hono().put('/', async (c) => {
  const allowed = localUploadAllowed(new URL(c.req.url).searchParams)
  if (!allowed) throw new HTTPException(403, { message: 'This upload URL is not valid' })
  const declared = c.req.header('content-length')
  if (declared !== undefined && Number(declared) !== allowed.size)
    throw new HTTPException(400, { message: `Send exactly ${allowed.size} bytes` })
  const body = c.req.raw.body ?? new Response(new Uint8Array(0)).body!
  try {
    await putLocalStream(allowed.key, body, allowed.size)
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : 'Upload failed',
    })
  }
  return c.body(null, 200)
})
