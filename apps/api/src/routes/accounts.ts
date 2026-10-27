import { AddAccount, SubmitLoginCode, UpdateAccount, type AccountRef } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import type { ScopedDb } from '../db.js'
import { hubs } from '../hub.js'
import {
  parseBody,
  requireUser,
  requireWorkspace,
  type AppEnv,
  type WorkspaceScope,
} from '../scope.js'

type AccountRow = { id: string; provider: 'claude_code' | 'codex'; source: 'machine' | 'brigade' }
export const accountRef = (a: AccountRow): AccountRef => ({
  id: a.id,
  provider: a.provider,
  source: a.source,
})

const providerName = (provider: string) => (provider === 'codex' ? 'Codex' : 'Claude')

/**
 * The member's usable accounts for a harness on a computer, best first: the
 * preferred one, then the default, then the rest. Never another member's.
 * Accounts that ran out of usage come last (the preferred one, then soonest
 * reset first): a plan upgraded or a limit lifted early only shows when the
 * provider is asked again, so a new message tries them rather than waiting.
 */
export async function usableAccounts(
  db: ScopedDb,
  input: {
    memberId: string
    computerId: string
    provider: 'claude_code' | 'codex'
    preferredId?: string | null
  },
) {
  const now = new Date()
  const rows = await db.account.findMany({
    where: {
      memberId: input.memberId,
      computerId: input.computerId,
      provider: input.provider,
      status: { in: ['ready', 'unverified'] },
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  const exhausted = (r: (typeof rows)[number]) =>
    r.exhaustedUntil && r.exhaustedUntil > now ? 1 : 0
  // Stable: the default, then the oldest, within each group.
  return rows.sort(
    (a, b) =>
      exhausted(a) - exhausted(b) ||
      Number(b.id === input.preferredId) - Number(a.id === input.preferredId) ||
      (exhausted(a) ? a.exhaustedUntil!.getTime() - b.exhaustedUntil!.getTime() : 0),
  )
}

async function loadOwn(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const account = await db.account.findFirst({
    where: { id, memberId: scope.memberId },
    include: { computer: true },
  })
  if (!account) throw new HTTPException(404, { message: 'Account not found' })
  return account
}

/** Run the vendor's sign-in on the account's computer, in its workspace's hub (src/logins.ts). */
async function startLogin(
  scope: WorkspaceScope,
  account: AccountRow & { computerId: string },
  computer: { id: string; kind: string },
) {
  const started = await hubs.get(scope.workspaceId).startLogin(
    {
      accountId: account.id,
      memberId: scope.memberId,
      computerId: account.computerId,
      account: accountRef(account),
    },
    computer,
  )
  if (started === 'offline') throw new HTTPException(409, { message: 'That computer is offline' })
}

export const accounts = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** The signed-in member's own harness accounts. Accounts are never shared. */
  .get('/', async (c) => {
    const rows = await c.var.db.account.findMany({
      where: { memberId: c.var.scope.memberId },
      include: { computer: { select: { id: true, name: true, kind: true } } },
      orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
    })
    const logins = rows.length
      ? await hubs.get(c.var.scope.workspaceId).loginStates(rows.map((a) => a.id))
      : {}
    return c.json(rows.map((a) => ({ ...a, login: logins[a.id] ?? null })))
  })

  /** Add an account by running the vendor's own sign-in on the computer. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, AddAccount)
    const computer = await db.computer.findFirst({ where: { id: input.computerId } })
    if (!computer || (computer.kind === 'member_machine' && computer.memberId !== scope.memberId)) {
      throw new HTTPException(404, { message: 'Computer not found' })
    }
    if (
      computer.kind === 'member_machine' &&
      !(await hubs.get(scope.workspaceId).isOnline(computer.id))
    ) {
      throw new HTTPException(409, { message: 'That computer is offline' })
    }
    const count = await db.account.count({
      where: { memberId: scope.memberId, provider: input.provider },
    })
    const hasDefault = await db.account.count({
      where: { memberId: scope.memberId, provider: input.provider, isDefault: true },
    })
    const account = await db.account.create({
      data: {
        memberId: scope.memberId,
        computerId: computer.id,
        provider: input.provider,
        source: 'brigade',
        label: input.label || `${providerName(input.provider)} account ${count + 1}`,
        status: 'signing_in',
        isDefault: hasDefault === 0,
      } as never,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'account.added',
      target: { type: 'account', id: account.id },
      data: { provider: account.provider, computerId: computer.id },
    })
    await startLogin(scope, account, computer)
    return c.json({ id: account.id }, 201)
  })

  /** Sign an account in again, e.g. after its login expired. */
  .post('/:id/sign-in', async (c) => {
    const { scope, db } = c.var
    const account = await loadOwn(db, scope, c.req.param('id'))
    if (account.source === 'machine') {
      throw new HTTPException(409, {
        message: `Sign in to ${providerName(account.provider)} on ${account.computer.name} itself`,
      })
    }
    await db.account.updateMany({ where: { id: account.id }, data: { status: 'signing_in' } })
    await startLogin(scope, account, account.computer)
    return c.json({ ok: true })
  })

  /**
   * The code shown on the vendor's page. Relayed to the computer; never stored or logged.
   * With it, optionally, the account's email, which a Claude token cannot tell.
   */
  .post('/:id/code', async (c) => {
    const { scope, db } = c.var
    const account = await loadOwn(db, scope, c.req.param('id'))
    const { code, email } = await parseBody(c.req.raw, SubmitLoginCode)
    const result = await hubs
      .get(scope.workspaceId)
      .submitLoginCode(account.id, scope.memberId, code, email)
    if (result === 'not-waiting')
      throw new HTTPException(409, { message: 'This account is not waiting for a code' })
    if (result === 'offline') throw new HTTPException(409, { message: 'That computer is offline' })
    return c.json({ ok: true })
  })

  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    const account = await loadOwn(db, scope, c.req.param('id'))
    const input = await parseBody(c.req.raw, UpdateAccount)
    if (input.isDefault) {
      await db.account.updateMany({
        where: { memberId: scope.memberId, provider: account.provider },
        data: { isDefault: false },
      })
    }
    await db.account.updateMany({ where: { id: account.id }, data: input })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'account.updated',
      target: { type: 'account', id: account.id },
      data: input,
    })
    return c.json({ ok: true })
  })

  /** Sign the account out on its computer and forget it. */
  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    const account = await loadOwn(db, scope, c.req.param('id'))
    const hub = hubs.get(scope.workspaceId)
    await hub.cancelLogin(account.id)
    if (account.source === 'brigade') {
      if (
        !(await hub.sendToRunner(account.computerId, {
          type: 'account.remove',
          account: accountRef(account),
        }))
      ) {
        throw new HTTPException(409, {
          message: 'That computer is offline. Start it to remove the login stored there.',
        })
      }
    }
    await db.account.deleteMany({ where: { id: account.id } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'account.removed',
      target: { type: 'account', id: account.id },
    })
    return c.body(null, 204)
  })
