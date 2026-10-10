import type { ThreadSpec } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { ScopedDb } from './db.js'
import { connectors, operationSpecs } from './connectors/index.js'
import { accountRef, usableAccounts } from './routes/accounts.js'

/**
 * Harness permission mode for a thread. Defaults: on a member's machine, ask
 * before every write and every command; on the cloud computer, allow built-in
 * tools (connector writes are checked by the API).
 */
function permissionMode(kind: 'cloud' | 'member_machine'): ThreadSpec['permissionMode'] {
  return kind === 'member_machine' ? 'allow-reads' : 'allow-all'
}

export async function loadThread(db: ScopedDb, id: string) {
  const thread = await db.session.findFirst({
    where: { id },
    include: {
      teammate: true,
      computer: true,
      teammates: { include: { teammate: true }, orderBy: { joinedAt: 'asc' } },
    },
  })
  if (!thread) throw new HTTPException(404, { message: 'Thread not found' })
  return thread
}

export type LoadedThread = Awaited<ReturnType<typeof loadThread>>
export type ThreadTeammate = LoadedThread['teammate']

/** The teammate a message that mentions nobody goes to: whoever was asked last. */
export function currentTeammate(thread: LoadedThread): ThreadTeammate {
  const latest = thread.teammates.reduce<LoadedThread['teammates'][number] | undefined>(
    (best, t) => (!best || t.lastTurnAt > best.lastTurnAt ? t : best),
    undefined,
  )
  return latest?.teammate ?? thread.teammate
}

/** A teammate of the thread by id; the thread's own when unknown or gone. */
export function teammateIn(thread: LoadedThread, teammateId: string | undefined): ThreadTeammate {
  return thread.teammates.find((t) => t.teammateId === teammateId)?.teammate ?? thread.teammate
}

/**
 * The teammate a runner says is acting in a thread: it must be in the thread.
 * Unset (an older runner): the thread's starting teammate.
 */
export async function actingTeammate(
  db: ScopedDb,
  session: { id: string; teammateId: string },
  teammateId: string | undefined,
) {
  const seat = await db.threadTeammate.findFirst({
    where: { sessionId: session.id, teammateId: teammateId ?? session.teammateId },
    include: { teammate: true },
  })
  if (seat) return seat.teammate
  return teammateId ? null : db.teammate.findFirst({ where: { id: session.teammateId } })
}

export const noAccount = (harness: string) =>
  new HTTPException(409, {
    message: `None of your ${harness === 'codex' ? 'Codex' : 'Claude'} accounts on this computer has usage left. Add one under Accounts, or wait for a reset.`,
  })

/**
 * The thread's spec, with the account it should run on next: its current
 * account if still usable, else the starter's next one. Never another member's.
 */
export async function specFor(
  db: ScopedDb,
  thread: LoadedThread,
  options: { requireUsage?: boolean; teammate?: ThreadTeammate } = {},
): Promise<ThreadSpec> {
  // The teammate whose turn it is; by default the one asked last.
  const teammate = options.teammate ?? currentTeammate(thread)
  const [account, ...fallbacks] = await usableAccounts(db, {
    memberId: thread.startedByMemberId,
    computerId: thread.computerId,
    provider: teammate.harness,
    preferredId: thread.accountId,
  })
  // Takeover and terminals need no usage: they may use the thread's current account as is.
  const current =
    account ??
    (options.requireUsage === false && thread.accountId
      ? await db.account.findFirst({ where: { id: thread.accountId, provider: teammate.harness } })
      : null)
  if (!current) throw noAccount(teammate.harness)
  // The connections this teammate is granted, as tool specs. Never a credential.
  const grants = await db.grant.findMany({
    where: { teammateId: teammate.id, connection: { status: { not: 'removed' } } },
    include: { connection: true },
  })
  return {
    connectors: grants
      .filter((g) => connectors[g.connection.kind])
      .map((g) => ({
        connectionId: g.connection.id,
        kind: g.connection.kind,
        label: g.connection.label,
        externalAccount: g.connection.externalAccount,
        scope: g.scope,
        operations: operationSpecs(g.connection.kind, g.scope),
      })),
    account: accountRef(current),
    fallbacks: fallbacks.map(accountRef),
    sessionId: thread.id,
    teammate: {
      id: teammate.id,
      name: teammate.name,
      instructions: teammate.instructions,
      harness: teammate.harness,
      model: teammate.model,
    },
    permissionMode: permissionMode(thread.computer.kind),
    starter: teammate.id === thread.teammateId,
    teammates: thread.teammates.map((t) => ({ id: t.teammate.id, name: t.teammate.name })),
    library: teammate.libraryAccess,
    private: thread.private,
  }
}
