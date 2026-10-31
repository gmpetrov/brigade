// A member being removed from their organization (src/member-remove.ts): Member.removingAt, set
// as their removal starts and cleared when it fails. One older than its lease (a removal cut
// short by a restart) no longer holds, so nobody is shut out for good by a removal that stopped.

/** How long a removal's fence holds without the removal ending. */
export const REMOVAL_LEASE_MS = 30 * 60_000

/** Whether a member is being removed. */
export const beingRemoved = (member: { removingAt: Date | null }, now = Date.now()) =>
  !!member.removingAt && member.removingAt.getTime() > now - REMOVAL_LEASE_MS
