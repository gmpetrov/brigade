// Whose AI accounts a member's work may run on: the one rule, kept here so it can change in
// one place. For now, as in Squad: the accounts on the workspace's cloud computer are the
// workspace's, so every member's threads, routines and triggers there can run on them, whoever
// signed them in; those on a member's own computer stay that member's. Going back to accounts
// of one's own only (each member signs in their own plan) is SHARED_ON_CLOUD = false.
import type { Prisma } from './db.js'
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
