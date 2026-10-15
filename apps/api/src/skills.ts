// Skills: how the workspace does a kind of work, written by its admins or
// proposed by a teammate and approved by one. A thread gets those that apply
// to it in its spec, and its runner writes them where the harness reads them.
import {
  SkillContent,
  type SaveSkill,
  type Skill,
  type SkillFile,
  type SkillProposal,
  type SkillProposalPayload,
  type ThreadSkill,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { audit, type Actor } from './audit.js'
import type { Scope, ScopedDb } from './db.js'
import { actorNames } from './library-history.js'

type Row = Awaited<ReturnType<ScopedDb['skill']['findFirstOrThrow']>>

const filesOf = (row: Row) => (Array.isArray(row.files) ? (row.files as SkillFile[]) : [])

export async function toSkills(db: ScopedDb, rows: Row[]): Promise<Skill[]> {
  const name = await actorNames(
    db,
    rows.map((r) => ({ type: r.updatedByType, id: r.updatedById })),
  )
  return rows.map((row) => {
    const by = name(row.updatedByType, row.updatedById)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      files: filesOf(row),
      everywhere: row.everywhere,
      teammateIds: row.teammateIds,
      projectIds: row.projectIds,
      enabled: row.enabled,
      updatedBy:
        by && (by.type === 'member' || by.type === 'teammate')
          ? { type: by.type, name: by.name }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  })
}

export const listSkills = (db: ScopedDb) => db.skill.findMany({ orderBy: { name: 'asc' } })

/** Create one, or change the one with `id`. Teammates and projects that are gone are dropped. */
export async function saveSkill(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: z.output<typeof SaveSkill>,
  id?: string,
) {
  if (id && !(await db.skill.findFirst({ where: { id } })))
    throw new HTTPException(404, { message: 'Skill not found' })
  const clash = await db.skill.findFirst({
    where: { name: input.name, ...(id ? { NOT: { id } } : {}) },
  })
  if (clash) throw new HTTPException(409, { message: `A skill is already named ${input.name}` })
  const [teammates, projects] = await Promise.all([
    db.teammate.findMany({
      where: { id: { in: input.teammateIds }, archivedAt: null },
      select: { id: true },
    }),
    db.project.findMany({ where: { id: { in: input.projectIds } }, select: { id: true } }),
  ])
  const data = {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    files: input.files,
    everywhere: input.everywhere,
    teammateIds: teammates.map((t) => t.id),
    projectIds: projects.map((p) => p.id),
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

/** The skills a thread gets: enabled, and for every thread or its teammate or project. */
export async function threadSkills(
  db: ScopedDb,
  teammateId: string,
  projectId: string | null = null,
): Promise<ThreadSkill[]> {
  const rows = await db.skill.findMany({
    where: {
      enabled: true,
      OR: [
        { everywhere: true },
        { teammateIds: { has: teammateId } },
        ...(projectId ? [{ projectIds: { has: projectId } }] : []),
      ],
    },
    orderBy: { name: 'asc' },
  })
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    files: filesOf(row),
  }))
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
            files: filesOf(existing).map((f) => f.path),
          },
        }
      : {}),
    teammateId: teammate.id,
    ...(proposal.reason ? { reason: proposal.reason } : {}),
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
 * everywhere, a change keeps where the skill applied and whether it is on.
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
    await saveSkill(
      db,
      scope,
      // Written by the teammate; the member's approval is in the audit log.
      { type: 'teammate', id: payload.teammateId },
      {
        ...skill.data,
        everywhere: existing?.everywhere ?? true,
        teammateIds: existing?.teammateIds ?? [],
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
