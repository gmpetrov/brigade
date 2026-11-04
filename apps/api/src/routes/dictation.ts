// Dictation in the composers (src/dictation.ts): whether the microphone works, and a
// recording turned into text.
import { DICTATION_MAX_BYTES } from '@brigade/contracts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { dictationStatus, requireDictation, transcribe, transcriber } from '../dictation.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const dictation = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await dictationStatus(c.var.scope.workspaceId)))

  /**
   * The recording (multipart: `audio`), its words in JSON: `{ text }`. Its body is read only up
   * to the limit, however it comes (a length or chunks): the API's object holds every
   * workspace's requests, and a recording must never fill its memory.
   */
  .post(
    '/',
    bodyLimit({
      maxSize: DICTATION_MAX_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: 'Recordings can be up to 20 MB' }, 413),
    }),
    async (c) => {
      await requireDictation(c.var.scope.workspaceId)
      const form = await c.req.parseBody()
      const audio = form.audio
      if (!(audio instanceof Blob))
        throw new HTTPException(400, { message: 'Attach the recording' })
      return c.json(await transcribe(audio, { to: transcriber()! }))
    },
  )
