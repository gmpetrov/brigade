// Sign-ins in progress, kept by the hub of the workspace whose computer runs them (src/hub/):
// its runner says how one goes on its socket. The one-time code passes through and is never
// stored, logged or written to an event. Each function runs in that hub (hubs.get).
import { randomUUID } from 'node:crypto'
import type { AccountRef, ApiToBrowser } from '@brigade/contracts'
import { currentHub } from './hub/context.js'

export type PendingLogin = {
  loginId: string
  accountId: string
  memberId: string
  computerId: string
  account: AccountRef
  /** The account's email as the member gave it, kept if the sign-in succeeds. */
  email?: string
  /** The last progress message, so a dashboard that opens later can catch up. */
  last: Extract<ApiToBrowser, { type: 'account.login' }>
}

/** The running hub's sign-ins, by id: kept with it, a sign-in outlives its hibernation. */
const logins = () => currentHub().durable<PendingLogin>('logins')

export function beginLogin(input: Omit<PendingLogin, 'loginId' | 'last'>): PendingLogin {
  for (const login of logins().values())
    if (login.accountId === input.accountId) logins().delete(login.loginId)
  const login: PendingLogin = {
    ...input,
    loginId: randomUUID(),
    last: { type: 'account.login', accountId: input.accountId, state: 'starting' },
  }
  logins().set(login.loginId, login)
  return login
}

export const loginById = (loginId: string) => logins().get(loginId)
export const loginForAccount = (accountId: string) =>
  logins()
    .values()
    .find((l) => l.accountId === accountId)
export const endLogin = (loginId: string) => logins().delete(loginId)

/** Change a sign-in under way: its email, its last progress. */
export function updateLogin(loginId: string, patch: Partial<Pick<PendingLogin, 'email' | 'last'>>) {
  const login = logins().get(loginId)
  if (login) logins().set(loginId, { ...login, ...patch })
}

/** Sign-ins a computer was running when its runner went away. */
export function loginsOnComputer(computerId: string) {
  return logins()
    .values()
    .filter((l) => l.computerId === computerId)
}

/**
 * In the hub: start the vendor's sign-in on the computer, and tell the member's dashboards.
 * 'offline' when a member's machine is not connected.
 */
export async function startLogin(
  input: Omit<PendingLogin, 'loginId' | 'last'>,
  computer: { id: string; kind: string },
) {
  const hub = currentHub()
  const login = beginLogin(input)
  const sent = await hub.dispatch(computer, {
    type: 'account.login.start',
    loginId: login.loginId,
    account: input.account,
  })
  if (sent === 'offline') {
    endLogin(login.loginId)
    return 'offline' as const
  }
  hub.sendToMember(input.memberId, login.last)
  return login.last
}

/** In the hub: where each account's sign-in stands, for its list. */
export function loginStates(accountIds: string[]) {
  return Object.fromEntries(accountIds.map((id) => [id, loginForAccount(id)?.last ?? null]))
}

/**
 * In the hub: the code the member read on the vendor's page, relayed to the computer; never
 * stored or logged. With it, optionally, the account's email, which a Claude token cannot tell.
 */
export function submitLoginCode(
  accountId: string,
  memberId: string,
  code: string,
  email?: string,
): 'not-waiting' | 'offline' | 'ok' {
  const hub = currentHub()
  const login = loginForAccount(accountId)
  if (!login || login.memberId !== memberId) return 'not-waiting'
  if (email) updateLogin(login.loginId, { email })
  if (
    !hub.sendToRunner(login.computerId, {
      type: 'account.login.code',
      loginId: login.loginId,
      code,
    })
  )
    return 'offline'
  const last = { type: 'account.login' as const, accountId, state: 'verifying' as const }
  updateLogin(login.loginId, { last })
  hub.sendToMember(memberId, last)
  return 'ok'
}

/** In the hub: the account's sign-in under way, if any, is cancelled on its computer. */
export function cancelLogin(accountId: string) {
  const login = loginForAccount(accountId)
  if (!login) return
  currentHub().sendToRunner(login.computerId, {
    type: 'account.login.cancel',
    loginId: login.loginId,
  })
  endLogin(login.loginId)
}
