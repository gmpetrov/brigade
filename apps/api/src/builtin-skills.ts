// Brigade's own skills in Settings › Skills (docs/skills.md): listed for everyone, read-only, and
// those marked switchable (BUILTIN_SKILLS) turned off for the workspace by an owner or admin.
// Threads that start after leave out what is off (the spec's `builtinSkillsOff`).
import { BUILTIN_SKILLS, LIBRARY_SKILL, type BuiltinSkillView } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { prisma, type Scope, type ScopedDb } from './db.js'
import { actorNames } from './library-history.js'

const TOGGLED = 'skill.builtin_toggled'

/** Instructions that read the same in every thread: shown whole. The others are built per thread. */
const FIXED_INSTRUCTIONS: Record<string, string> = {
  [LIBRARY_SKILL.name]: LIBRARY_SKILL.instructions,
}

export async function builtinSkillViews(db: ScopedDb): Promise<BuiltinSkillView[]> {
  const workspace = await db.workspace.findFirst({ select: { builtinSkillsOff: true } })
  const off = new Set(workspace?.builtinSkillsOff ?? [])
  // Who turned each one off: its last toggle.
  const last = off.size
    ? await db.auditEntry.findMany({
        where: { action: TOGGLED, targetType: 'builtin_skill', targetId: { in: [...off] } },
        orderBy: { at: 'desc' },
        select: { actorType: true, actorId: true, targetId: true, at: true },
      })
    : []
  const name = await actorNames(
    db,
    last.map((e) => ({ type: e.actorType, id: e.actorId })),
  )
  return BUILTIN_SKILLS.map((skill) => {
    const enabled = !(skill.switchable && off.has(skill.name))
    const toggle = enabled ? undefined : last.find((e) => e.targetId === skill.name)
    const by = toggle ? name(toggle.actorType, toggle.actorId) : null
    return {
      name: skill.name,
      description: skill.description,
      switchable: skill.switchable,
      enabled,
      instructions: FIXED_INSTRUCTIONS[skill.name] ?? null,
      offBy: toggle && by ? { name: by.name, at: toggle.at.toISOString() } : null,
    }
  })
}

/** Turn one of Brigade's switchable skills on or off for the workspace, in one statement. */
export async function setBuiltinSkill(scope: Scope, actor: Actor, name: string, enabled: boolean) {
  const skill = BUILTIN_SKILLS.find((s) => s.name === name)
  if (!skill) throw new HTTPException(404, { message: `Brigade has no skill called ${name}` })
  if (!skill.switchable)
    throw new HTTPException(400, { message: `${name} is always on: Brigade needs it` })
  await prisma.$executeRaw`
    UPDATE "Workspace"
    SET "builtinSkillsOff" = array_remove("builtinSkillsOff", ${name}) ||
      (CASE WHEN ${enabled} THEN ARRAY[]::text[] ELSE ARRAY[${name}]::text[] END)
    WHERE "id" = ${scope.workspaceId} AND "organizationId" = ${scope.organizationId}`
  await audit({
    ...scope,
    actor,
    action: TOGGLED,
    target: { type: 'builtin_skill', id: name },
    data: { enabled },
  })
}
