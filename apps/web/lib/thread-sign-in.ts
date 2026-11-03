import type { Account, AccountLogin } from './api'

/** A sign-in that still waits on the computer or on the member. */
const UNDER_WAY = new Set<AccountLogin['state']>(['starting', 'open_url', 'verifying'])
export const underWay = (login: AccountLogin | null) => !!login && UNDER_WAY.has(login.state)

/**
 * An account's sign-in as its thread's error card shows it: the progress heard on the socket,
 * else the one the account list says is under way, wherever it was started (the card, or
 * Accounts in another tab). Only to whoever added the account: the API shows it to no one else.
 */
export const shownLogin = (live: AccountLogin | null, account: Account | undefined) =>
  live ?? (account?.mine ? account.login : null)

/**
 * Where a sign-in stands once the socket is back, as the account list says: what the socket said
 * meanwhile is lost. A sign-in still going (or failed) shows as the list has it. One the card
 * followed and that ended unheard worked when the account is ready again, and did not otherwise.
 * Null: nothing to change.
 */
export function caughtUp(
  account: Account | undefined,
  followed: boolean,
): { live: AccountLogin | null; done?: true; interrupted?: true } | null {
  if (!account?.mine) return null
  if (account.login)
    return account.login.state === 'done'
      ? { live: account.login, done: true }
      : { live: account.login }
  if (!followed) return null
  return account.status === 'ready' ? { live: null, done: true } : { live: null, interrupted: true }
}
