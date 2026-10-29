import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// A library file's bytes, one bucket object per save (src/library-objects.ts), against the API's
// development database (apps/api/.env), in an organization of its own removed at the end; skipped
// when no database answers. The reviews of the Lists pull request (#487) found bytes lost for
// good when a save's write to the file's one key landed late: past its lease, after a crash, or
// with no saved version to put them back from. Here each comes back on the new model:
// - a write that lands after a newer save, and its save crashing then, leaves the newer bytes;
// - a large file's late write, with the newer save's version failing too, leaves them as well;
// - a save too late to claim its object is refused, and changes nothing; its bytes, if they land
//   after its object was swept, are found by listing and removed;
// - objects nothing points to go from the bucket a grace period on, never one a row or a version
//   points to; a file deleted for good leaves none;
// - files from before keep their bytes at the legacy key until their next save, and an API from
//   before that saves one points its row back there.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'library-objects-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "LibraryObject" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const encode = (text: string) => new TextEncoder().encode(text)
const onDisk = (key: string) => existsSync(join(process.env.BUCKET_DIR!, key))

describe('library objects', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace', string>
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let library: typeof import('../src/library.js')
  let objects: typeof import('../src/library-objects.js')
  let history: typeof import('../src/library-history.js')
  let bucket: typeof import('../src/bucket.js')
  const member = () => ({ type: 'member' as const, id: ids.member })
  const save = (path: string, text: string, actor = member()) =>
    library.saveLibraryFile(db, scope, actor, { path, bytes: encode(text) })
  const row = async (id: string) => (await db.document.findFirst({ where: { id } }))!

  /** The file's bytes as every reader gets them, checked against its row. */
  const consistent = async (id: string, starts: string) => {
    const file = await row(id)
    const bytes = await library.readLibraryFile(scope, file)
    assert.equal(new TextDecoder().decode(bytes.subarray(0, starts.length)), starts)
    assert.equal(sha(bytes), file.sha256, 'the bytes are those its row names')
    const text = await library.documentText(scope, file)
    assert.equal(sha(text), file.sha256)
    const committed = await library.committedBytes(scope, file)
    assert.ok(committed && sha(committed) === file.sha256)
    return file
  }

  /** The sweep, as if its objects had been made, then found unreferenced, an hour and more ago. */
  const sweepLater = async (documentId: string) => {
    const past = new Date(Date.now() - 2 * 60 * 60_000)
    await prisma.libraryObject.updateMany({ where: { documentId }, data: { createdAt: past } })
    await objects.sweepLibraryObjects()
    await prisma.libraryObject.updateMany({
      where: { documentId, unreferencedAt: { not: null } },
      data: { unreferencedAt: past },
    })
    await objects.sweepLibraryObjects()
  }

  /**
   * Hold the bucket write of the save whose bytes start with `marker` until `release`: the
   * stand-in bucket writes with fs.writeFile.
   */
  async function stallWrite(documentId: string | null, marker: string) {
    const fs = (await import('node:fs/promises')).default
    const { syncBuiltinESMExports } = await import('node:module')
    const original = fs.writeFile
    let entered!: () => void
    let release!: () => void
    let landed!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const written = new Promise<void>((resolve) => (landed = resolve))
    ;(fs as { writeFile: unknown }).writeFile = async (
      ...args: Parameters<typeof fs.writeFile>
    ) => {
      const [path, bytes] = args
      const ours =
        String(path).includes(`/library-objects/${documentId ?? ''}`) &&
        bytes instanceof Uint8Array &&
        new TextDecoder().decode(bytes.subarray(0, 64)).includes(marker)
      if (!ours) return original(...args)
      entered()
      await gate
      await original(...args)
      landed()
    }
    syncBuiltinESMExports()
    return {
      reached,
      written,
      release,
      restore: () => {
        ;(fs as { writeFile: unknown }).writeFile = original
        syncBuiltinESMExports()
      },
    }
  }

  before(async () => {
    library = await import('../src/library.js')
    objects = await import('../src/library-objects.js')
    history = await import('../src/library-history.js')
    bucket = await import('../src/bucket.js')
    ids.org = `org-objects-${suffix}`
    ids.user = `user-objects-${suffix}`
    ids.member = `m-objects-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Objects', slug: `objects-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Objects' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
  })

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  /**
   * A save under a lease whose bucket write is held until a newer save has landed, then lands.
   * `lease`: a real one of 300 ms, or one that never returns from its commit: the process crashed
   * right after its late write.
   */
  async function lateWrite(
    path: string,
    padding: string,
    options: { crash?: boolean; newer?: ReturnType<typeof scoped> } = {},
  ) {
    const file = await save(path, '* [ ] Initial\n' + padding)
    const stall = await stallWrite(file.id, 'Slow stale edit')
    try {
      const write = (lease: import('../src/library.js').LibraryLease) =>
        library.saveLibraryFile(
          db,
          scope,
          member(),
          { path, bytes: encode('* [x] Slow stale edit\n' + padding) },
          {},
          { lease },
        )
      const slow = options.crash
        ? // Its lease is past (another save took the lock), then the process dies: nothing after
          // its write ever runs.
          write({ check: () => {}, fence: () => new Promise<never>(() => {}) })
        : library.withLibraryLock(scope, file.id, write, { leaseMs: 300 })
      const failed = slow.then(
        () => null,
        (error: unknown) => error,
      )
      await stall.reached
      if (!options.crash) await new Promise((resolve) => setTimeout(resolve, 400))
      await library.saveLibraryFile(options.newer ?? db, scope, member(), {
        path,
        bytes: encode('* [x] New winning edit\n' + padding),
      })
      stall.release()
      await stall.written
      if (!options.crash) assert.match(String(await failed), /took too long/)
    } finally {
      stall.restore()
    }
    return file
  }

  test('a write that lands after a newer save leaves the newer bytes (r4)', async () => {
    const file = await lateWrite('Late/r4.md', '')
    const saved = await consistent(file.id, '* [x] New winning edit')
    assert.equal(saved.bytesStaleAt, null)
    // The late bytes are in an object of their own, which no row points to.
    const late = await prisma.libraryObject.findMany({ where: { documentId: file.id } })
    const pointed = new Set(
      [
        saved.objectKey,
        ...(await db.documentVersion.findMany({ where: { documentId: file.id } })).map(
          (v) => v.objectKey,
        ),
      ].filter(Boolean),
    )
    const stray = late.filter((o) => !pointed.has(o.key) && onDisk(o.key))
    const slow = []
    for (const o of stray) {
      const bytes = await bucket.getObject(o.key)
      if (new TextDecoder().decode(bytes!).includes('Slow stale edit')) slow.push(o.key)
    }
    assert.equal(slow.length, 1, 'the late write landed')
    await sweepLater(file.id)
    assert.equal(onDisk(slow[0]!), false, 'and goes with the sweep')
    await consistent(file.id, '* [x] New winning edit')
  })

  test("a large file's late write, the newer save's version failing too, leaves the newer bytes (r5)", async () => {
    // The newer save keeps no version: its row's text is cut, and nothing else holds its bytes
    // but its object.
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'documentVersion') return Reflect.get(target, prop)
        return new Proxy(target.documentVersion, {
          get(model, key) {
            if (key !== 'findFirst') return Reflect.get(model, key)
            return async (args: { orderBy?: unknown }) => {
              if (args.orderBy) throw new Error('version store down')
              return model.findFirst(args as never)
            }
          },
        })
      },
    })
    const padding = '\n' + 'x'.repeat(400_001)
    const file = await lateWrite('Late/r5.md', padding, { newer: failing })
    const saved = await consistent(file.id, '* [x] New winning edit')
    assert.ok(saved.text.length < saved.size, "the row's text is cut")
    const versions = await db.documentVersion.findMany({ where: { documentId: file.id } })
    assert.ok(!versions.some((v) => v.sha256 === saved.sha256), 'no version of the newer save')
    await sweepLater(file.id)
    await consistent(file.id, '* [x] New winning edit')
  })

  test('a crash right after a late write leaves the newer bytes, for good (r5-crash)', async () => {
    const file = await lateWrite('Late/crash.md', '\n' + 'y'.repeat(400_001), { crash: true })
    const saved = await consistent(file.id, '* [x] New winning edit')
    assert.equal(saved.bytesStaleAt, null)
    // Nothing repairs anything: the sweep, as often as it runs, only removes the late object.
    await sweepLater(file.id)
    await sweepLater(file.id)
    await consistent(file.id, '* [x] New winning edit')
    const left = await prisma.libraryObject.findMany({ where: { documentId: file.id } })
    for (const o of left) assert.ok(onDisk(o.key))
    assert.ok(left.some((o) => o.key === saved.objectKey))
  })

  test('a save too late to claim its object is refused and changes nothing', async () => {
    const file = await save('Late/expired.txt', 'before')
    const stall = await stallWrite(file.id, 'too late')
    try {
      const late = library.saveLibraryFile(db, scope, member(), {
        path: 'Late/expired.txt',
        bytes: encode('too late'),
      })
      await stall.reached
      // It stalled past the grace period: the sweep found its object unclaimed.
      await prisma.libraryObject.updateMany({
        where: { documentId: file.id, key: { not: file.objectKey! } },
        data: { unreferencedAt: new Date() },
      })
      stall.release()
      await assert.rejects(late, /took too long to save/)
    } finally {
      stall.restore()
    }
    const after = await consistent(file.id, 'before')
    assert.equal(after.objectKey, file.objectKey)
  })

  test('a write landing after its object was swept is found and removed (review of #494)', async () => {
    const file = await save('Late/orphan.txt', 'before')
    const stall = await stallWrite(file.id, 'orphan after sweep')
    try {
      const late = library
        .saveLibraryFile(db, scope, member(), {
          path: 'Late/orphan.txt',
          bytes: encode('orphan after sweep'),
        })
        .catch((error: unknown) => error)
      await stall.reached
      const pending = (
        await prisma.libraryObject.findMany({
          where: { documentId: file.id, key: { not: file.objectKey! } },
        })
      ).find((o) => !onDisk(o.key))!
      assert.ok(pending)
      // Paused past both grace periods: its object is swept, row and all, before it writes.
      await sweepLater(file.id)
      assert.equal(await prisma.libraryObject.count({ where: { key: pending.key } }), 0)
      stall.release()
      assert.match(String(await late), /took too long to save/)
      assert.ok(onDisk(pending.key), 'the late bytes landed, with no row naming them')
      await objects.sweepOrphanLibraryObjects()
      assert.equal(onDisk(pending.key), false, 'found by listing, and deleted')
    } finally {
      stall.release()
      stall.restore()
    }
    // Objects with a row stay, whatever their age.
    const current = await consistent(file.id, 'before')
    assert.ok(onDisk(current.objectKey!))
  })

  test('superseded objects go a grace period on, once no version points to them', async () => {
    const other = { type: 'system' as const, id: 'objects-test' }
    const a = await save('Sweep/notes.md', 'A')
    const b = await save('Sweep/notes.md', 'B', other)
    // The same author again moments later: its version now points to C, not B.
    const c = await save('Sweep/notes.md', 'C', other)
    assert.notEqual(a.objectKey, b.objectKey)
    // Too recent for the sweep, however unreferenced.
    await objects.sweepLibraryObjects()
    assert.ok(onDisk(b.objectKey!))
    await sweepLater(a.id)
    assert.ok(onDisk(a.objectKey!), "A's version points to it")
    assert.equal(onDisk(b.objectKey!), false, 'B: folded into C')
    assert.equal(await prisma.libraryObject.count({ where: { key: b.objectKey! } }), 0)
    assert.ok(onDisk(c.objectKey!))
    const versions = await db.documentVersion.findMany({
      where: { documentId: a.id },
      orderBy: { createdAt: 'asc' },
    })
    assert.deepEqual(
      versions.map((v) => v.objectKey),
      [a.objectKey, c.objectKey],
    )
    for (const v of versions)
      assert.equal(sha(await history.readVersion(scope, v)), v.sha256, 'each version its bytes')
  })

  test('a file deleted for good leaves no object', async () => {
    const file = await save('Gone/file.md', 'one')
    await save('Gone/file.md', 'two', { type: 'system', id: 'objects-test' })
    const keys = (await prisma.libraryObject.findMany({ where: { documentId: file.id } })).map(
      (o) => o.key,
    )
    assert.equal(keys.length, 2)
    await history.trashLibraryFile(db, scope, member(), file.id, { quiet: true })
    await history.purgeLibraryFile(db, scope, member(), file.id)
    await sweepLater(file.id)
    for (const key of keys) assert.equal(onDisk(key), false)
    assert.equal(await prisma.libraryObject.count({ where: { documentId: file.id } }), 0)
  })

  test('a file from before keeps its legacy key until its next save', async () => {
    const legacy = await db.document.create({
      data: {
        kind: 'library',
        path: 'Legacy/old.md',
        contentType: 'text/markdown',
        size: 6,
        sha256: sha('legacy'),
        text: 'legacy',
      },
    } as never)
    await bucket.putObject(bucket.documentKey(scope, legacy.id), encode('legacy'), 'text/markdown')
    await consistent(legacy.id, 'legacy')
    const saved = await save('Legacy/old.md', 'saved since')
    assert.ok(saved.objectKey)
    await consistent(legacy.id, 'saved since')
    // Its first version: the legacy bytes, copied to an object of their own.
    const first = await db.documentVersion.findFirst({
      where: { documentId: legacy.id, sha256: sha('legacy') },
    })
    assert.ok(first?.objectKey)
    assert.equal(new TextDecoder().decode(await history.readVersion(scope, first)), 'legacy')

    // An API from before saves it (to the legacy key, its row without objectKey): read from there.
    await bucket.putObject(bucket.documentKey(scope, legacy.id), encode('old API'), 'text/markdown')
    await prisma.document.update({
      where: { id: legacy.id },
      data: { sha256: sha('old API'), size: 7, text: 'old API' },
    })
    assert.equal((await row(legacy.id)).objectKey, null)
    await consistent(legacy.id, 'old API')
    // And folds a save into a version, writing its legacy key.
    const latest = (await db.documentVersion.findFirst({
      where: { documentId: legacy.id },
      orderBy: { createdAt: 'desc' },
    }))!
    await bucket.putObject(bucket.versionKey(scope, latest.id), encode('old API'), 'text/markdown')
    const folded = await prisma.documentVersion.update({
      where: { id: latest.id },
      data: { sha256: sha('old API') },
    })
    assert.equal(folded.objectKey, null)
    assert.equal(sha(await history.readVersion(scope, folded)), folded.sha256)
  })

  test('a legacy file a late write overwrote is saved again as an object, nothing written over', async () => {
    const legacy = await db.document.create({
      data: {
        kind: 'library',
        path: 'Legacy/stale.md',
        contentType: 'text/markdown',
        size: 5,
        sha256: sha('right'),
        text: 'right',
        bytesStaleAt: new Date(),
      },
    } as never)
    const key = bucket.documentKey(scope, legacy.id)
    await bucket.putObject(key, encode('wrong, landed late'), 'text/markdown')
    await library.repairStaleBytes()
    const repaired = await consistent(legacy.id, 'right')
    assert.equal(repaired.bytesStaleAt, null)
    assert.ok(repaired.objectKey)
    assert.equal(
      new TextDecoder().decode((await bucket.getObject(key))!),
      'wrong, landed late',
      'the legacy key is left as it was',
    )
  })
})
