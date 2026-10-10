// Git backups the runner keeps in the bucket when GitHub would not take them
// (a read-only grant, say): a bundle of what a teammate had not pushed in one
// checkout. Authenticated by the runner's token; only threads on its computer.
//   PUT /runner/backups/<owner>/<name>/<thread>/<teammate>/<folder>   (the bundle)
//   GET  the same, to restore it into a new checkout
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { RepositoryName } from '@brigade/contracts'
import { audit } from '../audit.js'
import { getObject, putObject, repoBackupKey } from '../bucket.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'

/** A bundle of unpushed work is small; anything larger belongs on GitHub. */
const BUNDLE_MAX = 50 * 1024 * 1024

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

  .put(PATH, async (c) => {
    const { backup, key } = await backupOf(c)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > BUNDLE_MAX)
      throw new HTTPException(413, { message: 'A backup bundle is up to 50 MB' })
    await putObject(key, bytes, 'application/x-git-bundle')
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
    const bytes = await getObject(key)
    if (!bytes) throw new HTTPException(404, { message: 'No backup' })
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/x-git-bundle',
    })
  })
