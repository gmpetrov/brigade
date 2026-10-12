// The chief: the teammate every workspace has one of. Its role is written in
// the runner (instructions.ts); here it is created, kept unique and given the
// workspace's roster so it can route work.
import { CHIEF_NAME, isChiefName } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { prisma, type ScopedDb } from './db.js'

/** Give a workspace its chief, unless it has one. */
export async function ensureChief(workspace: { id: string; organizationId: string }) {
  const existing = await prisma.teammate.findFirst({
    where: { workspaceId: workspace.id, kind: 'chief' },
  })
  if (existing) return existing
  return prisma.teammate.create({
    data: {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      name: CHIEF_NAME,
      kind: 'chief',
    },
  })
}

/** The chief's name is its own: another teammate may not take it. */
export function refuseChiefName(name: string | undefined) {
  if (name !== undefined && isChiefName(name))
    throw new HTTPException(400, { message: `"${CHIEF_NAME}" is the chief's name. Pick another.` })
}

/** A teammate's role for the roster: the first line of its instructions. */
const roleOf = (instructions: string) =>
  instructions
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? ''

/** Every other active teammate, for the chief to route work to. */
export async function chiefRoster(db: ScopedDb) {
  const rows = await db.teammate.findMany({
    where: { archivedAt: null, kind: 'teammate' },
    select: { id: true, name: true, instructions: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((t) => ({ id: t.id, name: t.name, role: roleOf(t.instructions) }))
}
