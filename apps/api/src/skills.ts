// Skills: how the workspace does a kind of work, written by its admins,
// imported (one, or a pack of them), or proposed by a teammate and approved by
// an admin. Their text is in the database and their files in the bucket, by
// SHA-256. A thread gets those that apply in its spec; its runner fetches the
// files and writes each skill where the harness reads it.
import { createHash } from 'node:crypto'
import {
  SkillContent,
  SkillFileRef,
  type ImportedSkill,
  type SaveSkill,
  type SaveSkillPack,
  type Skill,
  type SkillCommand,
  type SkillFile,
  type SkillImport,
  type SkillPack,
  type SkillProposal,
  type SkillProposalPayload,
  type SkillScope,
  SkillWithFiles,
  type ThreadSkill,
  type UpdateSkillPack,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { audit, type Actor } from './audit.js'
import { getObject, putObject, skillFileKey } from './bucket.js'
import type { Scope, ScopedDb } from './db.js'
import { actorNames } from './library-history.js'
import type { FoundSkill } from './skill-import.js'

type Row = Awaited<ReturnType<ScopedDb['skill']['findFirstOrThrow']>>
type PackRow = Awaited<ReturnType<ScopedDb['skillPack']['findFirstOrThrow']>>

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Its files in the bucket; those kept inline before packs are left out until moved. */
const refsOf = (row: Row): SkillFileRef[] =>
  (Array.isArray(row.files) ? row.files : []).flatMap((f) => {
    const ref = SkillFileRef.safeParse(f)
    return ref.success ? [ref.data] : []
  })

/** Files kept inline, as skills were saved before packs: `[{ path, content }]`. */
const inlineOf = (row: Row): SkillFile[] =>
  (Array.isArray(row.files) ? row.files : []).flatMap((f) =>
    f && typeof f === 'object' && 'content' in f && typeof f.content === 'string'
      ? [{ path: String((f as { path: unknown }).path), content: f.content }]
      : [],
  )

/** Keep a file in the bucket. The same bytes are one object, whatever the skill. */
export async function storeSkillFile(scope: Scope, path: string, bytes: Uint8Array) {
  const hash = sha256(bytes)
  await putObject(skillFileKey(scope, hash), bytes, 'application/octet-stream')
  return { path, sha256: hash, size: bytes.byteLength }
}

export async function readSkillFile(scope: Scope, hash: string) {
  return getObject(skillFileKey(scope, hash))
}

/** Text files put in the bucket: a teammate's proposal, a skill saved before packs. */
const storeText = (scope: Scope, files: SkillFile[]) =>
  Promise.all(files.map((f) => storeSkillFile(scope, f.path, new TextEncoder().encode(f.content))))

/** Move the files of skills saved before packs into the bucket, once. */
async function moveInlineFiles(db: ScopedDb, scope: Scope, rows: Row[]) {
  return Promise.all(
    rows.map(async (row) => {
      const inline = inlineOf(row)
      if (inline.length === 0) return row
      const files = [...refsOf(row), ...(await storeText(scope, inline))]
      return db.skill.update({ where: { id: row.id }, data: { files } })
    }),
  )
}

export async function toSkills(db: ScopedDb, rows: Row[]): Promise<Skill[]> {
  const packs = await db.skillPack.findMany({
    where: { id: { in: rows.flatMap((r) => r.packId ?? []) } },
    select: { id: true, enabled: true },
  })
  const name = await actorNames(
    db,
    rows.map((r) => ({ type: r.updatedByType, id: r.updatedById })),
  )
  const photos = await db.member.findMany({
    where: {
      id: { in: rows.flatMap((r) => (r.updatedByType === 'member' && r.updatedById) || []) },
    },
    select: { id: true, user: { select: { image: true } } },
  })
  return rows.map((row) => {
    const by = name(row.updatedByType, row.updatedById)
    const pack = packs.find((p) => p.id === row.packId)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      files: refsOf(row),
      everywhere: row.everywhere,
      teammateIds: row.teammateIds,
      projectIds: row.projectIds,
      enabled: row.enabled,
      packId: row.packId,
      active: row.enabled && (pack?.enabled ?? true),
      updatedBy:
        by && (by.type === 'member' || by.type === 'teammate')
          ? {
              type: by.type,
              id: by.id,
              name: by.name,
              image: photos.find((m) => m.id === by.id)?.user.image ?? null,
            }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  })
}

/** The skills that are on, their pack's switch too, by name: what the composer offers as `/name`. */
export function skillCommands(db: ScopedDb): Promise<SkillCommand[]> {
  return db.skill.findMany({
    where: { enabled: true, OR: [{ packId: null }, { pack: { enabled: true } }] },
    select: { name: true, description: true },
    orderBy: { name: 'asc' },
  })
}

export async function listSkills(db: ScopedDb, scope: Scope) {
  return moveInlineFiles(db, scope, await db.skill.findMany({ orderBy: { name: 'asc' } }))
}

/** Teammates and projects that still exist, of those asked for. */
async function liveScope(db: ScopedDb, input: Partial<SkillScope>) {
  const [teammates, projects] = await Promise.all([
    input.teammateIds
      ? db.teammate.findMany({
          where: { id: { in: input.teammateIds }, archivedAt: null },
          select: { id: true },
        })
      : undefined,
    input.projectIds
      ? db.project.findMany({ where: { id: { in: input.projectIds } }, select: { id: true } })
      : undefined,
  ])
  return {
    ...(input.everywhere !== undefined ? { everywhere: input.everywhere } : {}),
    ...(teammates ? { teammateIds: teammates.map((t) => t.id) } : {}),
    ...(projects ? { projectIds: projects.map((p) => p.id) } : {}),
  }
}

/**
 * Create one, or change the one with `id`. Teammates and projects that are gone
 * are dropped; a skill in a pack keeps its pack's scope.
 */
export async function saveSkill(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: z.output<typeof SaveSkill>,
  id?: string,
) {
  const existing = id ? await db.skill.findFirst({ where: { id } }) : null
  if (id && !existing) throw new HTTPException(404, { message: 'Skill not found' })
  const clash = await db.skill.findFirst({
    where: { name: input.name, ...(id ? { NOT: { id } } : {}) },
  })
  if (clash) throw new HTTPException(409, { message: `A skill is already named ${input.name}` })
  const data = {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    files: input.files,
    ...(existing?.packId ? {} : await liveScope(db, input)),
    enabled: input.enabled,
    updatedByType: actor.type,
    updatedById: actor.id,
  }
  const row = id
    ? await db.skill.update({ where: { id }, data })
    : await db.skill.create({
        data: { ...data, createdByType: actor.type, createdById: actor.id } as never,
      })
  await audit({
    ...scope,
    actor,
    action: id ? 'skill.updated' : 'skill.created',
    target: { type: 'skill', id: row.id },
    data: { name: row.name },
  })
  return row
}

export async function deleteSkill(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const row = await db.skill.findFirst({ where: { id } })
  if (!row) throw new HTTPException(404, { message: 'Skill not found' })
  await db.skill.delete({ where: { id } })
  await audit({
    ...scope,
    actor,
    action: 'skill.deleted',
    target: { type: 'skill', id },
    data: { name: row.name },
  })
}

/**
 * The skills a thread gets: on, in a pack that is on (if any), and for every
 * thread or its teammate or project. A pack's scope is written onto its skills.
 * A pack that came with an App only when the teammate can use one of its
 * accounts in the thread (`apps`); a playbook's only in that playbook's threads (`playbook`).
 */
export async function threadSkills(
  db: ScopedDb,
  teammateId: string,
  projectId: string | null = null,
  apps: ReadonlySet<string> = new Set(),
  playbook: string | null = null,
): Promise<ThreadSkill[]> {
  const rows = await db.skill.findMany({
    where: {
      enabled: true,
      AND: [
        {
          OR: [
            { packId: null },
            { pack: { enabled: true, appId: null, playbookInstallationId: null } },
            { pack: { enabled: true, appId: { in: [...apps] }, playbookInstallationId: null } },
            ...(playbook ? [{ pack: { enabled: true, playbookInstallationId: playbook } }] : []),
          ],
        },
        {
          OR: [
            { everywhere: true },
            { teammateIds: { has: teammateId } },
            ...(projectId ? [{ projectIds: { has: projectId } }] : []),
          ],
        },
      ],
    },
    orderBy: { name: 'asc' },
  })
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    files: inlineOf(row),
    refs: refsOf(row),
  }))
}

// ---------------------------------------------------------------------------
// Packs: skills imported together, with one scope and one switch
// ---------------------------------------------------------------------------

export const toPack = (row: PackRow & { app?: { key: string } | null }): SkillPack => ({
  id: row.id,
  name: row.name,
  source: row.source,
  appKey: row.app?.key ?? null,
  everywhere: row.everywhere,
  teammateIds: row.teammateIds,
  projectIds: row.projectIds,
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const listPacks = (db: ScopedDb) =>
  db.skillPack.findMany({ orderBy: { name: 'asc' }, include: { app: { select: { key: true } } } })

const sameFiles = (a: SkillFileRef[], b: SkillFileRef[]) =>
  a.length === b.length && a.every((f) => b.some((g) => g.path === f.path && g.sha256 === f.sha256))

/**
 * What an upload or a repository holds, and what adding each skill would do.
 * Its files go to the bucket now, so adding them later sends only their refs.
 */
export async function previewImport(
  db: ScopedDb,
  scope: Scope,
  source: string,
  label: string,
  found: FoundSkill[],
): Promise<SkillImport> {
  const pack = await db.skillPack.findFirst({ where: { source } })
  const existing = await db.skill.findMany({
    where: { name: { in: found.map((f) => f.name).filter(Boolean) } },
  })
  const seen = new Set<string>()
  const skills: ImportedSkill[] = []
  for (const f of found) {
    const files: SkillFileRef[] = []
    // A few at a time: a pack can hold hundreds of files.
    for (let i = 0; i < f.files.length; i += 8)
      files.push(
        ...(await Promise.all(
          f.files.slice(i, i + 8).map((file) => storeSkillFile(scope, file.path, file.bytes)),
        )),
      )
    const base = {
      folder: f.folder,
      name: f.name,
      description: f.description,
      instructions: f.instructions,
      files,
      skipped: f.skipped,
    }
    const valid = SkillWithFiles.safeParse(base)
    const problem = !valid.success
      ? valid.error.issues.map((i) => `${i.path.join('.') || 'skill'}: ${i.message}`).join('; ')
      : seen.has(f.name)
        ? 'another skill in it has the same name'
        : undefined
    seen.add(f.name)
    if (problem) {
      skills.push({ ...base, status: 'invalid', problem })
      continue
    }
    const same = existing.find((e) => e.name === f.name)
    if (!same) skills.push({ ...base, status: 'new' })
    else if (!pack || same.packId !== pack.id)
      skills.push({
        ...base,
        status: 'taken',
        problem: same.packId
          ? 'a skill of another pack has this name'
          : 'a skill of yours has this name',
      })
    else
      skills.push({
        ...base,
        status:
          same.description === f.description &&
          same.instructions === valid.data!.instructions &&
          sameFiles(refsOf(same), files)
            ? 'same'
            : 'update',
        enabled: same.enabled,
      })
  }
  return { source, label, pack: pack ? toPack(pack) : null, skills }
}

/**
 * Add an import's skills as a pack, or update the pack from the same source:
 * each skill new to it is created, each in it already updated, its switch as
 * sent. Skills of the pack the import no longer has stay as they are.
 */
export async function savePack(db: ScopedDb, scope: Scope, actor: Actor, input: SaveSkillPack) {
  const where = input.packId ? { id: input.packId } : { source: input.source }
  const found = await db.skillPack.findFirst({ where })
  if (input.packId && !found) throw new HTTPException(404, { message: 'Pack not found' })
  const names = input.skills.map((s) => s.name)
  if (new Set(names).size !== names.length)
    throw new HTTPException(400, { message: 'Two skills in the pack have the same name' })
  const taken = await db.skill.findMany({
    where: { name: { in: names }, ...(found ? { NOT: { packId: found.id } } : {}) },
    select: { name: true },
  })
  if (taken.length > 0)
    throw new HTTPException(409, {
      message: `Already skills outside this pack: ${taken.map((t) => t.name).join(', ')}`,
    })
  const reach = await liveScope(db, input)
  const pack = found
    ? await db.skillPack.update({ where: { id: found.id }, data: { name: input.name, ...reach } })
    : await db.skillPack.create({
        data: {
          name: input.name,
          source: input.source,
          ...reach,
          createdByType: actor.type,
          createdById: actor.id,
        } as never,
      })
  const inPack = await db.skill.findMany({ where: { packId: pack.id } })
  const packScope = {
    everywhere: pack.everywhere,
    teammateIds: pack.teammateIds,
    projectIds: pack.projectIds,
  }
  for (const s of input.skills) {
    const data = {
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      files: s.files,
      enabled: s.enabled,
      ...packScope,
      updatedByType: actor.type,
      updatedById: actor.id,
    }
    const current = inPack.find((r) => r.name === s.name)
    if (current) await db.skill.update({ where: { id: current.id }, data })
    else
      await db.skill.create({
        data: {
          ...data,
          packId: pack.id,
          createdByType: actor.type,
          createdById: actor.id,
        } as never,
      })
  }
  await db.skill.updateMany({ where: { packId: pack.id }, data: packScope })
  await audit({
    ...scope,
    actor,
    action: found ? 'skill_pack.updated' : 'skill_pack.created',
    target: { type: 'skill_pack', id: pack.id },
    data: { name: pack.name, source: pack.source, skills: names.length },
  })
  return pack
}

/** A pack's name, scope (written onto its skills) or switch. */
export async function updatePack(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  id: string,
  input: UpdateSkillPack,
) {
  const found = await db.skillPack.findFirst({ where: { id } })
  if (!found) throw new HTTPException(404, { message: 'Pack not found' })
  // A playbook's recipe loads only in its threads, and goes with it: it can be turned off, no more.
  if (
    found.playbookInstallationId &&
    (input.everywhere !== undefined || input.teammateIds || input.projectIds)
  )
    throw new HTTPException(409, { message: playbookPack })
  const pack = await db.skillPack.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(await liveScope(db, input)),
    },
  })
  await db.skill.updateMany({
    where: { packId: id },
    data: {
      everywhere: pack.everywhere,
      teammateIds: pack.teammateIds,
      projectIds: pack.projectIds,
    },
  })
  await audit({
    ...scope,
    actor,
    action: 'skill_pack.updated',
    target: { type: 'skill_pack', id },
    data: { name: pack.name, ...input },
  })
  return pack
}

const playbookPack =
  "This pack is a playbook's recipe: it loads only in the playbook's threads and goes when the playbook is uninstalled"

/** The pack goes, and its skills with it. */
export async function deletePack(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const pack = await db.skillPack.findFirst({ where: { id } })
  if (!pack) throw new HTTPException(404, { message: 'Pack not found' })
  if (pack.playbookInstallationId) throw new HTTPException(409, { message: playbookPack })
  await db.skillPack.delete({ where: { id } })
  await audit({
    ...scope,
    actor,
    action: 'skill_pack.deleted',
    target: { type: 'skill_pack', id },
    data: { name: pack.name, source: pack.source },
  })
}

// ---------------------------------------------------------------------------
// A teammate's proposal: a ticket an admin approves, which saves the skill
// ---------------------------------------------------------------------------

/**
 * Open the ticket for a teammate's proposal. It does not wait: the teammate
 * goes on, and the skill applies to threads that start after an admin approves.
 * A proposal for a skill that already has an open one replaces it.
 */
export async function proposeSkill(
  db: ScopedDb,
  scope: Scope,
  teammate: { id: string; name: string },
  sessionId: string,
  proposal: SkillProposal,
) {
  const { skill } = proposal
  const existing = await db.skill.findFirst({ where: { name: skill.name } })
  const payload: SkillProposalPayload = {
    skillAction: existing ? 'update' : 'create',
    ...(existing ? { skillId: existing.id } : {}),
    skill,
    ...(existing
      ? {
          previous: {
            description: existing.description,
            instructions: existing.instructions,
            files: [...refsOf(existing), ...inlineOf(existing)].map((f) => f.path),
          },
        }
      : {}),
    teammateId: teammate.id,
    ...(proposal.reason ? { reason: proposal.reason } : {}),
    ...(proposal.teammateOnly && !existing ? { teammateOnly: true } : {}),
  }
  const replaced = await db.ticket.updateMany({
    where: {
      type: 'approval',
      status: 'open',
      // Only a skill proposal's payload has a skill.
      payload: { path: ['skill', 'name'], equals: skill.name },
    },
    data: { status: 'resolved', resolvedAt: new Date() },
  })
  const ticket = await db.ticket.create({
    data: {
      sessionId,
      type: 'approval',
      title: existing
        ? `${teammate.name}: change the skill ${skill.name}`
        : `${teammate.name}: add the skill ${skill.name}`,
      payload: payload as never,
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'skill.proposed',
    target: { type: 'ticket', id: ticket.id },
    data: { name: skill.name, change: !!existing },
  })
  return { ticketId: ticket.id, change: !!existing, replaced: replaced.count > 0 }
}

/**
 * An admin's answer to a proposal. Approving saves it: a new skill applies
 * everywhere, or to its teammate only when it asked; a change keeps where the skill applied, whether it is on, its
 * pack, and the files the proposal does not replace (a teammate proposes text,
 * so a pack's fonts or templates stay).
 */
export async function decideSkillProposal(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  ticket: { id: string; payload: unknown },
  approved: boolean,
) {
  const payload = ticket.payload as SkillProposalPayload
  const member: Actor = { type: 'member', id: scope.memberId }
  if (approved) {
    const skill = SkillContent.safeParse(payload.skill)
    if (!skill.success)
      throw new HTTPException(400, { message: 'This proposal is not a valid skill' })
    const existing = await db.skill.findFirst({ where: { name: skill.data.name } })
    const proposed = await storeText(scope, skill.data.files)
    const kept = existing
      ? refsOf(existing).filter((f) => !proposed.some((p) => p.path === f.path))
      : []
    await saveSkill(
      db,
      scope,
      // Written by the teammate; the member's approval is in the audit log.
      { type: 'teammate', id: payload.teammateId },
      {
        ...skill.data,
        files: [...kept, ...proposed],
        everywhere: existing?.everywhere ?? !payload.teammateOnly,
        teammateIds: existing?.teammateIds ?? (payload.teammateOnly ? [payload.teammateId] : []),
        projectIds: existing?.projectIds ?? [],
        enabled: existing?.enabled ?? true,
      },
      existing?.id,
    )
  }
  await db.ticket.updateMany({
    where: { id: ticket.id, status: 'open' },
    data: {
      status: approved ? 'approved' : 'denied',
      resolvedByMemberId: scope.memberId,
      resolvedAt: new Date(),
    },
  })
  await audit({
    ...scope,
    actor: member,
    action: approved ? 'skill.approved' : 'skill.rejected',
    target: { type: 'ticket', id: ticket.id },
    data: { name: payload.skill?.name },
  })
}
