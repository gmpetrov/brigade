// A member being removed from their organization (src/member-remove.ts): Member.removingAt, set
// as their removal starts and cleared when it fails. One older than its lease (a removal cut
// short by a restart) no longer holds, so nobody is shut out for good by a removal that stopped.
import { prisma } from './db.js'

/** How long a removal's fence holds without the removal ending. */
export const REMOVAL_LEASE_MS = 30 * 60_000

/** Whether a member is being removed. */
export const beingRemoved = (member: { removingAt: Date | null }, now = Date.now()) =>
  !!member.removingAt && member.removingAt.getTime() > now - REMOVAL_LEASE_MS

/**
 * Which of these members' dashboards no longer hold: gone, being removed, or of another role than
 * their socket was opened with. The hub closes them (src/hub/workspace-hub.ts), whether or not
 * the change's own notice reached it.
 */
export async function lapsedMembers(scopes: { memberId: string; role: string }[]) {
  if (!scopes.length) return new Set<string>()
  const rows = await prisma.member.findMany({
    where: { id: { in: [...new Set(scopes.map((s) => s.memberId))] } },
    select: { id: true, role: true, removingAt: true },
  })
  const now = Date.now()
  const holding = new Map(rows.filter((r) => !beingRemoved(r, now)).map((r) => [r.id, r.role]))
  return new Set(scopes.filter((s) => holding.get(s.memberId) !== s.role).map((s) => s.memberId))
}
