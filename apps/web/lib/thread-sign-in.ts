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

/**
 * The catch-up after a reconnect, from the account list (load). The socket may say more while the
 * list loads: then what it said is newer than the list, which is dropped. heard counts the
 * sign-in's messages heard on the socket.
 */
export async function catchUpAfterReconnect(
  load: () => Promise<Account[]>,
  accountId: string,
  followed: () => boolean,
  heard: () => number,
) {
  const before = heard()
  const list = await load()
  if (heard() !== before) return null
  return caughtUp(
    list.find((a) => a.id === accountId),
    followed(),
  )
}

/**
 * Where each signed-out account signs in: its latest failed turn's error, by account. An
 * earlier one (tried again, and failed again) would show the same sign-in a second time.
 */
export function signInCards(items: { kind: string; key: string; signedOutAccountId?: string }[]) {
  const at = new Map<string, string>()
  for (const it of items)
    if (it.kind === 'error' && it.signedOutAccountId) at.set(it.signedOutAccountId, it.key)
  return at
}
