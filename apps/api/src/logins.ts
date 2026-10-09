// Sign-ins in progress. Held in memory only: the one-time code passes through
// and is never stored, logged or written to an event.
import { randomUUID } from 'node:crypto'
import type { AccountRef, ApiToBrowser } from '@brigade/contracts'

export type PendingLogin = {
  loginId: string
  accountId: string
  memberId: string
  computerId: string
  account: AccountRef
  /** The last progress message, so a dashboard that opens later can catch up. */
  last: Extract<ApiToBrowser, { type: 'account.login' }>
}

const byLoginId = new Map<string, PendingLogin>()

export function beginLogin(input: Omit<PendingLogin, 'loginId' | 'last'>): PendingLogin {
  for (const login of byLoginId.values())
    if (login.accountId === input.accountId) byLoginId.delete(login.loginId)
  const login: PendingLogin = {
    ...input,
    loginId: randomUUID(),
    last: { type: 'account.login', accountId: input.accountId, state: 'starting' },
  }
  byLoginId.set(login.loginId, login)
  return login
}

export const loginById = (loginId: string) => byLoginId.get(loginId)
export const loginForAccount = (accountId: string) =>
  [...byLoginId.values()].find((l) => l.accountId === accountId)
export const endLogin = (loginId: string) => byLoginId.delete(loginId)

/** Sign-ins a computer was running when its runner went away. */
export function loginsOnComputer(computerId: string) {
  return [...byLoginId.values()].filter((l) => l.computerId === computerId)
}
