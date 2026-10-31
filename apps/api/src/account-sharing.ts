// Whose AI accounts a member's work may run on: the one rule, kept here so it can change in
// one place. For now, as in Squad: the accounts on the workspace's cloud computer are the
// workspace's, so every member's threads, routines and triggers there can run on them, whoever
// signed them in; those on a member's own computer stay that member's. Going back to accounts
// of one's own only (each member signs in their own plan) is SHARED_ON_CLOUD = false.
//
// Who writes in a thread follows: one on the cloud computer runs on the workspace's accounts, so
// every member but a viewer writes in it, answers its questions and steers it, whoever started
// it; one on a member's own computer stays theirs, unless they let others in (othersMayPrompt).
import { prisma, type Prisma } from './db.js'
import { beingRemoved } from './member-fence.js'
import type { Role } from './scope.js'

export const SHARED_ON_CLOUD = true

/** The accounts `memberId` may run on, as a filter on Account. */
export const usableBy = (memberId: string): Prisma.AccountWhereInput =>
  SHARED_ON_CLOUD ? { OR: [{ memberId }, { computer: { kind: 'cloud' } }] } : { memberId }

/** Whether an account is the workspace's rather than its member's alone. */
export const isShared = (computer: { kind: string }) => SHARED_ON_CLOUD && computer.kind === 'cloud'

/**
 * Who manages an account: its member signs it in again, makes it their default or removes it.
 * A shared one an owner or admin can remove too.
 */
export const mayManage = (
  account: { memberId: string; computer: { kind: string } },
  by: { memberId: string; role: Role },
  action: 'sign-in' | 'update' | 'remove',
) =>
  account.memberId === by.memberId ||
  (action === 'remove' &&
    isShared(account.computer) &&
    (by.role === 'owner' || by.role === 'admin'))

/** Whether members other than its starter write in a thread. */
export const openToOthers = (thread: { othersMayPrompt: boolean; computer: { kind: string } }) =>
  thread.othersMayPrompt || isShared(thread.computer)

/** Whether a member writes in a thread: its starter, or anyone once it is open; never a viewer. */
export const mayWrite = (
  thread: {
    startedByMemberId: string | null
    othersMayPrompt: boolean
    computer: { kind: string }
  },
  by: { memberId: string; role: Role },
) => by.role !== 'viewer' && (thread.startedByMemberId === by.memberId || openToOthers(thread))

/** mayWrite for a member known by id only (a mail, a teammate's call): their role read here. */
export async function memberMayWrite(
  thread: { startedByMemberId: string | null; othersMayPrompt: boolean; computerId: string },
  memberId: string,
) {
  const [member, computer] = await Promise.all([
    prisma.member.findUnique({ where: { id: memberId }, select: { role: true, removingAt: true } }),
    prisma.computer.findUnique({ where: { id: thread.computerId }, select: { kind: true } }),
  ])
  return (
    !!member &&
    !beingRemoved(member) &&
    !!computer &&
    mayWrite({ ...thread, computer }, { memberId, role: member.role as Role })
  )
}
