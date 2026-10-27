// What a cloud computer's runner backs up of what lives only on its disk, beside thread folders
// (runner-folders.ts), for a computer that replaces it (src/cloud-replace.ts). Authenticated by the
// runner's token; only its own workspace's teammates and its own computer's accounts.
//   GET  /runner/computer/backup-key   the key it encrypts its backups with (vault.ts backupKey)
//   POST /runner/computer/teammates/<teammate>/<kind>/upload  { size }  → where to PUT it
//   POST /runner/computer/teammates/<teammate>/<kind>/done    { size }  → checked, kept (TeammateBackup)
//   GET  /runner/computer/teammates/<teammate>/<kind>         the bytes: a signed URL's redirect with R2
//        kind: tasks (crontab, systemd user services) or browser (the profile's sign-ins)
//   PUT  /runner/computer/accounts/<account>/login  AccountLogin → sealed in the vault's way
//   GET  /runner/computer/accounts/<account>/login  → AccountLogin, or 404
// The bytes go straight between the runner and the bucket, encrypted by the runner; account
// logins are a few kilobytes of JSON, sealed with the vault's key, never in the bucket.
// While the computer is being replaced, the new runner has not put the backups back yet: what it
// would back up is empty, so its teammates' backups are refused (409) until it has.
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { AccountLogin, TEAMMATE_BACKUP_KINDS, type TeammateBackupKind } from '@brigade/contracts'
import {
  deleteObject,
  directUploads,
  objectSize,
  presignGet,
  readHead,
  SEALED_MAGIC,
  streamObject,
  teammateBackupKey,
  uploadTarget,
} from '../bucket.js'
import { restoring } from '../cloud-replace.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { parseBody } from '../scope.js'
import { backupKey, openValue, sealValue } from '../vault.js'

/** A browser profile's sign-ins, or a crontab and units: well under this. */
const BACKUP_MAX = 2 * 1024 ** 3
const SEALED = 'application/octet-stream'
const Size = z.object({ size: z.number().int().positive().max(BACKUP_MAX) })

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>
type Ctx = Context<{ Variables: { runner: Runner } }>

/** The teammate backup a request names: a teammate of the runner's workspace, a known kind. */
async function backupOf(c: Ctx) {
  const kind = c.req.param('kind') as TeammateBackupKind
  if (!TEAMMATE_BACKUP_KINDS.includes(kind))
    throw new HTTPException(400, { message: 'Unknown backup' })
  const teammate = await scoped(c.var.runner).teammate.findFirst({
    where: { id: c.req.param('teammateId') },
    select: { id: true },
  })
  if (!teammate) throw new HTTPException(404, { message: 'Unknown teammate' })
  return { teammateId: teammate.id, kind, key: teammateBackupKey(c.var.runner, teammate.id, kind) }
}

/** An account of the runner's computer, signed in through Brigade. */
async function accountOf(c: Ctx) {
  const account = await scoped(c.var.runner).account.findFirst({
    where: { id: c.req.param('accountId'), computerId: c.var.runner.computerId, source: 'brigade' },
    select: { id: true },
  })
  if (!account) throw new HTTPException(404, { message: 'Unknown account' })
  return account
}

/** Nothing of what a runner backs up replaces a backup before it has put those back. */
async function notWhileRestoring(c: Ctx) {
  if (await restoring(c.var.runner.computerId))
    throw new HTTPException(409, {
      message: 'This computer is still putting back the backups of the one it replaces',
    })
}

export const runnerComputer = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  .get('/backup-key', async (c) => {
    const computer = await scoped(c.var.runner).computer.findFirst({
      where: { id: c.var.runner.computerId },
      select: { kind: true },
    })
    // A member's machine keeps its own files: it backs nothing up.
    if (computer?.kind !== 'cloud')
      throw new HTTPException(404, { message: 'Not a cloud computer' })
    return c.json({ key: backupKey(c.var.runner).toString('base64') })
  })

  .post('/teammates/:teammateId/:kind/upload', async (c) => {
    const { key } = await backupOf(c)
    await notWhileRestoring(c)
    const { size } = await parseBody(c.req.raw, Size)
    return c.json(await uploadTarget(key, size, SEALED))
  })

  .post('/teammates/:teammateId/:kind/done', async (c) => {
    const { teammateId, kind, key } = await backupOf(c)
    await notWhileRestoring(c)
    const { size } = await parseBody(c.req.raw, Size)
    const stored = await objectSize(key)
    if (stored !== size)
      throw new HTTPException(409, {
        message: `The bucket has ${stored ?? 'no'} bytes for this backup, not ${size}`,
      })
    const head = await readHead(key, SEALED_MAGIC.length)
    if (!head || SEALED_MAGIC.some((byte, i) => head[i] !== byte)) {
      await deleteObject(key)
      throw new HTTPException(409, { message: 'The bucket holds no backup here; upload it again' })
    }
    const data = { computerId: c.var.runner.computerId, size: BigInt(size), takenAt: new Date() }
    await scoped(c.var.runner).teammateBackup.upsert({
      where: { teammateId_kind: { teammateId, kind } },
      create: { teammateId, kind, ...data } as never,
      update: data,
    })
    return c.json({ ok: true })
  })

  .get('/teammates/:teammateId/:kind', async (c) => {
    const { teammateId, kind, key } = await backupOf(c)
    const row = await scoped(c.var.runner).teammateBackup.findFirst({
      where: { teammateId, kind },
      select: { id: true },
    })
    if (!row) throw new HTTPException(404, { message: 'No backup' })
    if (directUploads) {
      if ((await objectSize(key)) === null) throw new HTTPException(404, { message: 'No backup' })
      const { url } = await presignGet(key, { contentType: SEALED, disposition: 'attachment' })
      return c.redirect(url, 302)
    }
    const body = await streamObject(key)
    if (!body) throw new HTTPException(404, { message: 'No backup' })
    return c.body(body, 200, { 'content-type': SEALED })
  })

  /** An account's login files changed: kept, sealed, in place of the ones before. */
  .put('/accounts/:accountId/login', async (c) => {
    const account = await accountOf(c)
    const login = await parseBody(c.req.raw, AccountLogin)
    const db = scoped(c.var.runner)
    const sealed = sealValue(c.var.runner, login.files)
    await db.accountLoginBackup.upsert({
      where: { accountId: account.id },
      create: { accountId: account.id, sha256: login.sha256, ...sealed } as never,
      update: { sha256: login.sha256, ...sealed },
    })
    return c.json({ ok: true })
  })

  .get('/accounts/:accountId/login', async (c) => {
    const account = await accountOf(c)
    const row = await scoped(c.var.runner).accountLoginBackup.findFirst({
      where: { accountId: account.id },
    })
    if (!row) throw new HTTPException(404, { message: 'No login backed up' })
    return c.json({
      files: openValue<AccountLogin['files']>(c.var.runner, row),
      sha256: row.sha256,
    } satisfies AccountLogin)
  })
