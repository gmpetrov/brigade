// Git backups the runner keeps in the bucket when GitHub would not take them
// (a read-only grant, say): a bundle of what a teammate had not pushed in one
// checkout. The bundle goes straight from the runner to the bucket through a signed
// URL, never through the API, which reads it back as it streams to check it.
// Authenticated by the runner's token; only threads on its computer.
//   POST /runner/backups/<owner>/<name>/<thread>/<teammate>/<folder>/upload  { size, sha256 }
//        → where to PUT the bundle: { url, headers } (without R2, a path of the API's stand-in)
//   POST the same/done  { size, sha256 }  → checked in the bucket: its size, SHA-256 and that it
//        is a git bundle; else removed, 400
//   PUT  /runner/backups/<owner>/<name>/<thread>/<teammate>/<folder>   (the bundle; old runners)
//   GET  the same, to restore it into a new checkout
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { RepositoryName } from '@brigade/contracts'
import { audit } from '../audit.js'
import {
  deleteObject,
  directUploads,
  objectSize,
  presignGet,
  putObject,
  repoBackupKey,
  streamObject,
  uploadTarget,
} from '../bucket.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { inspectObject } from '../object-check.js'
import { parseBody } from '../scope.js'

/** A bundle of unpushed work is small; anything larger belongs on GitHub. */
const BUNDLE_MAX = 50 * 1024 * 1024
const TYPE = 'application/x-git-bundle'
/** What `git bundle create` writes first: v2, or v3 with capabilities (SHA-256 repositories). */
const BUNDLE_HEADERS = ['# v2 git bundle\n', '# v3 git bundle\n']

const Bundle = z.object({
  size: z.number().int().positive().max(BUNDLE_MAX),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256, in lowercase hex'),
})

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>

/** The backup a request names, once the thread is on the runner's computer with that teammate in it. */
async function backupOf(c: Context<{ Variables: { runner: Runner } }>) {
  const { runner } = c.var
  const repository = RepositoryName.safeParse(`${c.req.param('owner')}/${c.req.param('name')}`)
  if (!repository.success) throw new HTTPException(400, { message: 'Invalid repository' })
  const backup = {
    repository: repository.data,
    sessionId: c.req.param('sessionId')!,
    teammateId: c.req.param('teammateId')!,
    folder: c.req.param('folder')!.toLowerCase(),
  }
  const db = scoped(runner)
  const seat = await db.threadTeammate.findFirst({
    where: {
      sessionId: backup.sessionId,
      teammateId: backup.teammateId,
      session: { computerId: runner.computerId },
    },
  })
  if (!seat) throw new HTTPException(404, { message: 'Unknown thread' })
  let key: string
  try {
    key = repoBackupKey(runner, backup)
  } catch {
    throw new HTTPException(400, { message: 'Invalid backup name' })
  }
  return { backup, key }
}

const PATH = '/:owner/:name/:sessionId/:teammateId/:folder'

export const runnerBackups = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  /** Where to PUT a bundle of this size: a signed URL of the bucket. */
  .post(`${PATH}/upload`, async (c) => {
    const { key } = await backupOf(c)
    const { size } = await parseBody(c.req.raw, Bundle)
    return c.json(await uploadTarget(key, size, TYPE))
  })

  /** The upload is done: the bundle in the bucket is the runner's, whole, and a git bundle. */
  .post(`${PATH}/done`, async (c) => {
    const { backup, key } = await backupOf(c)
    const { size, sha256 } = await parseBody(c.req.raw, Bundle)
    const read = await inspectObject(key, { name: `${backup.folder}.bundle`, max: size })
    if (!read)
      throw new HTTPException(409, {
        message: 'The bundle has not reached storage; upload it again',
      })
    const header = new TextDecoder().decode(read.head.subarray(0, BUNDLE_HEADERS[0]!.length))
    if (read.size !== size || read.sha256 !== sha256 || !BUNDLE_HEADERS.includes(header)) {
      await deleteObject(key)
      throw new HTTPException(400, {
        message: 'The upload does not match the bundle; upload it again',
      })
    }
    await audit({
      organizationId: c.var.runner.organizationId,
      workspaceId: c.var.runner.workspaceId,
      actor: { type: 'runner', id: c.var.runner.id },
      action: 'repo.backed_up',
      target: { type: 'thread', id: backup.sessionId },
      data: { ...backup, size },
    })
    return c.json({ ok: true })
  })

  /**
   * The bundle through the API, held in memory. Runners before DIRECT_UPLOAD_PROTOCOL only:
   * remove once MIN_PROTOCOL_VERSION reaches it.
   */
  .put(PATH, async (c) => {
    const { backup, key } = await backupOf(c)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > BUNDLE_MAX)
      throw new HTTPException(413, { message: 'A backup bundle is up to 50 MB' })
    await putObject(key, bytes, TYPE)
    await audit({
      organizationId: c.var.runner.organizationId,
      workspaceId: c.var.runner.workspaceId,
      actor: { type: 'runner', id: c.var.runner.id },
      action: 'repo.backed_up',
      target: { type: 'thread', id: backup.sessionId },
      data: { ...backup, size: bytes.byteLength },
    })
    return c.json({ ok: true })
  })

  .get(PATH, async (c) => {
    const { key } = await backupOf(c)
    // From the bucket's short-lived URL, never through the API (fetch drops the token on the way).
    if (directUploads) {
      if ((await objectSize(key)) === null) throw new HTTPException(404, { message: 'No backup' })
      const signed = await presignGet(key, {
        contentType: TYPE,
        disposition: 'attachment',
      })
      return c.redirect(signed.url, 302)
    }
    const body = await streamObject(key)
    if (!body) throw new HTTPException(404, { message: 'No backup' })
    return c.body(body, 200, { 'content-type': TYPE })
  })
