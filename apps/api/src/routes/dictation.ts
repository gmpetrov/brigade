// Dictation in the composers (src/dictation.ts): whether the microphone works, and a
// recording turned into text.
import { DICTATION_MAX_BYTES } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { env } from '../config.js'
import { dictationStatus, requireDictation, transcribe } from '../dictation.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const dictation = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await dictationStatus(c.var.scope.workspaceId)))

  /** The recording (multipart: `audio`), its words in JSON: `{ text }`. */
  .post('/', async (c) => {
    await requireDictation(c.var.scope.workspaceId)
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > DICTATION_MAX_BYTES + 64 * 1024)
      throw new HTTPException(413, { message: 'Recordings can be up to 20 MB' })
    const form = await c.req.parseBody()
    const audio = form.audio
    if (!(audio instanceof Blob)) throw new HTTPException(400, { message: 'Attach the recording' })
    return c.json(await transcribe(audio, { key: env.GROQ_API_KEY! }))
  })
