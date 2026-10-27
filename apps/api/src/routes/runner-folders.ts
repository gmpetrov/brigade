// Thread folders a computer cleared to free disk: an archive of what the
// teammate made there (everything but folders git ignores), kept in the bucket
// until the thread comes back. The bytes go straight between the runner and
// R2 through signed URLs, never through the API's memory. Authenticated by the
// runner's token; only threads on its computer. A thread deleted since is 410 Gone.
//   POST   /runner/folders/<thread>/<teammate>/upload  { size }  → a signed PUT URL, or { url: null }
//   PUT    /runner/folders/<thread>/<teammate>   the archive, through the API (no R2: development)
//   POST   /runner/folders/<thread>/<teammate>/done    { size }  → checked in the bucket: its size,
//          and that it is a gzip archive (else removed, 409)
//   GET    the same, to put the folder back: redirects to a signed URL with R2
//   DELETE the same, once it is back on disk
//   GET    /runner/folders/<thread>/<teammate>/conversation  what was said up to its move to this computer
// And a backup of the folder while it is on disk (BACKUP_PROTOCOL), encrypted by the runner, kept
// as one per thread and teammate (FolderBackup) for a computer that replaces this one:
//   POST   /runner/folders/<thread>/<teammate>/backup/upload  { size }  → where to PUT it
//   POST   /runner/folders/<thread>/<teammate>/backup/done    FolderBackupDone → checked, kept
//   GET    /runner/folders/<thread>/<teammate>/backup/info    { takenAt, size, background }, or 404
//   GET    /runner/folders/<thread>/<teammate>/backup         the bytes: redirects to a signed URL with R2
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { BackgroundWork, FolderBackupDone } from '@brigade/contracts'
import { audit } from '../audit.js'
import {
  deleteObject,
  directUploads,
  folderArchiveKey,
  folderBackupKey,
  getObject,
  objectSize,
  presignGet,
  presignPut,
  putObject,
  readHead,
  SEALED_MAGIC,
  streamObject,
  uploadTarget,
} from '../bucket.js'
import { prisma, scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { parseBody } from '../scope.js'

/** One signed PUT to R2 takes up to 5 GiB. */
const ARCHIVE_MAX = 4 * 1024 ** 3
/** Through the API, held in memory: only without R2, in development. */
const THROUGH_API_MAX = 200 * 1024 * 1024
const TYPE = 'application/gzip'
/** As much conversation as the runner keeps for a handoff (harness TRANSCRIPT_CHARS). */
const TRANSCRIPT_CHARS = 40_000

const Size = z.object({ size: z.number().int().positive().max(ARCHIVE_MAX) })

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>

/** The archive a request names, once the thread is on the runner's computer with that teammate in it. */
async function archiveOf(c: Context<{ Variables: { runner: Runner } }>) {
  const { runner } = c.var
  const folder = { sessionId: c.req.param('sessionId')!, teammateId: c.req.param('teammateId')! }
  const seat = await scoped(runner).threadTeammate.findFirst({
    where: {
      sessionId: folder.sessionId,
      teammateId: folder.teammateId,
      session: { computerId: runner.computerId },
    },
  })
  if (!seat) {
    // Deleted: the runner removes its folder rather than trying again.
    const thread = await scoped(runner).session.findFirst({
      where: { id: folder.sessionId },
      select: { id: true },
    })
    throw thread
      ? new HTTPException(404, { message: 'Unknown thread' })
      : new HTTPException(410, { message: 'Thread deleted' })
  }
  try {
    return { folder, key: folderArchiveKey(runner, folder) }
  } catch {
    throw new HTTPException(400, { message: 'Invalid folder name' })
  }
}

const PATH = '/:sessionId/:teammateId'
const SEALED = 'application/octet-stream'

/**
 * The thread's arrival on its computer (ThreadSpec.moved) as the runner took it in: a folder
 * that has not taken the latest one in (a computer that replaced another, say, before the
 * thread's first turn there) would replace the backup it is to come from.
 */
async function takenIn(runner: Runner, sessionId: string, arrived: string | undefined) {
  const session = await scoped(runner).session.findFirst({
    where: { id: sessionId },
    select: { movedAt: true },
  })
  return !session?.movedAt || session.movedAt.toISOString() === arrived
}

export const runnerFolders = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  /** Where to upload an archive of this size: a signed URL of the bucket, or null for the API itself. */
  .post(`${PATH}/upload`, async (c) => {
    const { key } = await archiveOf(c)
    const { size } = await parseBody(c.req.raw, Size)
    if (!directUploads) {
      if (size > THROUGH_API_MAX)
        throw new HTTPException(413, { message: 'Without R2 a folder archive is up to 200 MB' })
      return c.json({ url: null })
    }
    return c.json(await presignPut(key, size, TYPE))
  })

  .put(PATH, async (c) => {
    if (directUploads) throw new HTTPException(400, { message: 'Upload to the signed URL' })
    const { key } = await archiveOf(c)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > THROUGH_API_MAX)
      throw new HTTPException(413, { message: 'Without R2 a folder archive is up to 200 MB' })
    await putObject(key, bytes, TYPE)
    return c.json({ ok: true })
  })

  /** The upload is done: the archive is in the bucket, whole, before the runner removes the folder. */
  .post(`${PATH}/done`, async (c) => {
    const { folder, key } = await archiveOf(c)
    const { size } = await parseBody(c.req.raw, Size)
    const stored = await objectSize(key)
    if (stored !== size)
      throw new HTTPException(409, {
        message: `The bucket has ${stored ?? 'no'} bytes for this archive, not ${size}`,
      })
    // Up to 4 GB: not hashed, but it must at least be what the runner makes (tar.gz).
    const head = await readHead(key, 2)
    if (!head || head[0] !== 0x1f || head[1] !== 0x8b) {
      await deleteObject(key)
      throw new HTTPException(409, {
        message: 'The bucket holds no gzip archive for this folder; upload it again',
      })
    }
    await audit({
      organizationId: c.var.runner.organizationId,
      workspaceId: c.var.runner.workspaceId,
      actor: { type: 'runner', id: c.var.runner.id },
      action: 'folder.archived',
      target: { type: 'thread', id: folder.sessionId },
      data: { ...folder, size },
    })
    return c.json({ ok: true })
  })

  .get(PATH, async (c) => {
    const { folder, key } = await archiveOf(c)
    if (directUploads) {
      if ((await objectSize(key)) === null) throw new HTTPException(404, { message: 'No archive' })
      const { url } = await presignGet(key, {
        contentType: TYPE,
        disposition: `attachment; filename="${folder.sessionId}.tar.gz"`,
      })
      return c.redirect(url, 302)
    }
    const bytes = await getObject(key)
    if (!bytes) throw new HTTPException(404, { message: 'No archive' })
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'content-type': TYPE })
  })

  /**
   * The thread moved here: what was said in it before, as the teammate's
   * conversation, newest last and at most TRANSCRIPT_CHARS. Its new session
   * starts from it (the harness's own stayed on the old computer).
   */
  .get(`${PATH}/conversation`, async (c) => {
    const { folder } = await archiveOf(c)
    const session = await scoped(c.var.runner).session.findFirst({
      where: { id: folder.sessionId },
      select: { teammateId: true, movedSeq: true },
    })
    if (session?.movedSeq == null) return c.json({ transcript: [] })
    const [rows, seats] = await Promise.all([
      prisma.sessionEvent.findMany({
        where: {
          sessionId: folder.sessionId,
          seq: { lte: session.movedSeq },
          type: { in: ['message.user', 'message.done'] },
        },
        orderBy: { seq: 'desc' },
        take: 500,
        select: { data: true },
      }),
      scoped(c.var.runner).threadTeammate.findMany({
        where: { sessionId: folder.sessionId },
        select: { teammate: { select: { id: true, name: true } } },
      }),
    ])
    const names = new Map(seats.map((s) => [s.teammate.id, s.teammate.name]))
    const transcript: { role: 'user' | 'assistant'; text: string }[] = []
    let budget = TRANSCRIPT_CHARS
    for (const { data } of rows) {
      const event = data as { type: string; text?: string; teammateId?: string }
      if (!event.text) continue
      const by = event.type === 'message.done' ? (event.teammateId ?? session.teammateId) : null
      const entry =
        by === folder.teammateId
          ? { role: 'assistant' as const, text: event.text }
          : {
              role: 'user' as const,
              text: by
                ? `${names.get(by) ?? 'Another teammate'} (teammate): ${event.text}`
                : event.text,
            }
      if (transcript.length > 0 && entry.text.length > budget) break
      transcript.unshift(entry)
      budget -= entry.text.length
    }
    return c.json({ transcript })
  })

  .delete(PATH, async (c) => {
    const { key } = await archiveOf(c)
    await deleteObject(key)
    return c.json({ ok: true })
  })

  /** Where to upload a backup of the folder of this size. */
  .post(`${PATH}/backup/upload`, async (c) => {
    const { folder } = await archiveOf(c)
    const { size } = await parseBody(c.req.raw, Size)
    return c.json(await uploadTarget(folderBackupKey(c.var.runner, folder), size, SEALED))
  })

  /**
   * The backup is in the bucket, whole: kept as the folder's, in place of the one before. An
   * archive of the folder is older by then (the folder is on disk): it goes.
   */
  .post(`${PATH}/backup/done`, async (c) => {
    const { folder, key: archive } = await archiveOf(c)
    const { runner } = c.var
    const done = await parseBody(c.req.raw, FolderBackupDone)
    if (done.size > ARCHIVE_MAX) throw new HTTPException(413, { message: 'Too large' })
    if (!(await takenIn(runner, folder.sessionId, done.arrived)))
      throw new HTTPException(409, {
        message: 'The thread moved here since: take it in before backing its folder up',
      })
    const key = folderBackupKey(runner, folder)
    const stored = await objectSize(key)
    if (stored !== done.size)
      throw new HTTPException(409, {
        message: `The bucket has ${stored ?? 'no'} bytes for this backup, not ${done.size}`,
      })
    const head = await readHead(key, SEALED_MAGIC.length)
    if (!head || SEALED_MAGIC.some((byte, i) => head[i] !== byte)) {
      await deleteObject(key)
      throw new HTTPException(409, { message: 'The bucket holds no backup here; upload it again' })
    }
    const data = {
      computerId: runner.computerId,
      size: BigInt(done.size),
      background: done.background,
      takenAt: new Date(),
    }
    await scoped(runner).folderBackup.upsert({
      where: { sessionId_teammateId: folder },
      create: { ...folder, ...data } as never,
      update: data,
    })
    await deleteObject(archive).catch((error) =>
      console.warn(`an old archive of ${folder.sessionId} stays: ${String(error)}`),
    )
    return c.json({ ok: true })
  })

  /** The folder's latest backup: when, how large, and what ran in the background then. */
  .get(`${PATH}/backup/info`, async (c) => {
    const { folder } = await archiveOf(c)
    const row = await scoped(c.var.runner).folderBackup.findFirst({
      where: { sessionId: folder.sessionId, teammateId: folder.teammateId },
    })
    if (!row) throw new HTTPException(404, { message: 'No backup' })
    return c.json({
      takenAt: row.takenAt.toISOString(),
      size: Number(row.size),
      background: z.array(BackgroundWork).catch([]).parse(row.background),
    })
  })

  /** The backup's bytes, from the bucket's short-lived URL with R2, never through the API's memory. */
  .get(`${PATH}/backup`, async (c) => {
    const { folder } = await archiveOf(c)
    const key = folderBackupKey(c.var.runner, folder)
    if (directUploads) {
      if ((await objectSize(key)) === null) throw new HTTPException(404, { message: 'No backup' })
      const { url } = await presignGet(key, { contentType: SEALED, disposition: 'attachment' })
      return c.redirect(url, 302)
    }
    const body = await streamObject(key)
    if (!body) throw new HTTPException(404, { message: 'No backup' })
    return c.body(body, 200, { 'content-type': SEALED })
  })
