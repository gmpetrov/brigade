import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Replacing a cloud computer (src/cloud-replace.ts), against the API's development database
// (apps/api/.env), in an organization of its own removed at the end; skipped when no database
// answers. Without a provider here, the new VM is never made: what is checked is what the rows
// say at each step:
// - the old VM's reference is kept on the replacement, never on the computer, whose runner's
//   token goes; every thread of the computer moves to the new VM, a busy one with a nudge;
// - its new runner's hello is told what to put back, and backups are refused until it has;
// - its report ends the replacement, with what did not come back.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
delete process.env.BOAT_API_KEY

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const until = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe('replacing a cloud computer', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'cloud' | 'kai' | 'idle' | 'busy',
    string
  >
  let scope: { organizationId: string; workspaceId: string }

  before(async () => {
    ids.org = `org-replace-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Replace', slug: `replace-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Replace' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    const db = scoped(scope)
    ids.cloud = (
      await db.computer.create({
        data: {
          kind: 'cloud',
          name: 'Cloud',
          status: 'error',
          providerRef: { provider: 'boat', id: 'bx_old' },
        },
      } as never)
    ).id
    await db.runner.create({
      data: { computerId: ids.cloud, tokenHash: `hash-${suffix}` },
    } as never)
    ids.kai = (await db.teammate.create({ data: { name: `Kai ${suffix}` } } as never)).id
    const session = (status: string) =>
      db.session.create({
        data: {
          teammateId: ids.kai,
          startedByMemberId: ids.owner,
          computerId: ids.cloud,
          title: status,
          status,
          lastSeq: 3,
        },
      } as never)
    ids.idle = (await session('idle')).id
    ids.busy = (await session('running')).id
    await db.sessionEvent.create({
      data: { sessionId: ids.busy, seq: 7, type: 'message.done', data: {}, at: new Date() },
    } as never)
    await db.teammateBackup.create({
      data: { teammateId: ids.kai, kind: 'tasks', computerId: ids.cloud, size: 10n },
    } as never)
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
  })

  test('the computer moves to a new VM, keeping the old one, and restores there', async () => {
    const { replaceComputer, restoreFor, restoring, onRestored, lastReplacement } =
      await import('../src/cloud-replace.js')
    const row = await replaceComputer(scope, ids.cloud, ids.owner)
    await assert.rejects(replaceComputer(scope, ids.cloud, ids.owner), /being replaced/)

    // Offline: no backup to wait for; the switch goes on at once.
    await until(
      async () =>
        (await prisma.computerReplacement.findUnique({ where: { id: row.id } }))?.phase ===
        'creating',
      'the switch',
    )
    const replacement = await prisma.computerReplacement.findUniqueOrThrow({
      where: { id: row.id },
    })
    assert.deepEqual(replacement.oldProviderRef, { provider: 'boat', id: 'bx_old' })
    assert.match(replacement.backup ?? '', /offline/)
    const computer = await prisma.computer.findUniqueOrThrow({ where: { id: ids.cloud } })
    assert.equal(computer.providerRef, null, 'never destroyed: the computer forgets it')
    assert.equal(await prisma.runner.count({ where: { computerId: ids.cloud } }), 0)
    assert.equal(await restoring(ids.cloud), true)

    const idle = await prisma.session.findUniqueOrThrow({ where: { id: ids.idle } })
    const busy = await prisma.session.findUniqueOrThrow({ where: { id: ids.busy } })
    assert.equal(idle.movedFrom, 'the cloud computer this one replaced')
    assert.equal(idle.movedSeq, 3)
    assert.equal(idle.move, null, 'a quiet thread takes its arrival in at its next turn')
    assert.equal(busy.movedSeq, 7, 'numbered after its last event')
    assert.equal(busy.status, 'idle')
    assert.equal((busy.move as { phase?: string } | null)?.phase, 'arriving')

    // The new VM's runner says hello: it is told what to put back.
    await prisma.runner.create({
      data: { ...scope, computerId: ids.cloud, tokenHash: `hash2-${suffix}` },
    })
    const restore = await restoreFor(ids.cloud)
    assert.equal(restore?.id, row.id)
    assert.deepEqual(restore?.teammateIds, [ids.kai])
    assert.equal(
      (await prisma.computerReplacement.findUniqueOrThrow({ where: { id: row.id } })).phase,
      'restoring',
    )

    await onRestored(
      { ...scope, computerId: ids.cloud },
      { id: row.id, problems: [{ teammateId: ids.kai, text: 'its browser did not come back' }] },
    )
    assert.equal(await restoring(ids.cloud), false)
    assert.equal(await restoreFor(ids.cloud), undefined)
    const shown = await lastReplacement(ids.cloud)
    assert.equal(shown?.phase, 'done')
    assert.deepEqual(
      shown?.problems.map((p) => p.text),
      ['its browser did not come back'],
    )
  })
})
