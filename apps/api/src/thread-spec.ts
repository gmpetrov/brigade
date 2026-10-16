import { folderExceptions, MCP_PROTOCOL, type ThreadSpec } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { usableIn } from './apps.js'
import { runnerProtocol } from './hub.js'
import { customMcp } from './mcp-servers.js'
import { isMcp, mcpOperationSpecs } from './mcp-tools.js'
import { threadAttachments } from './attachments.js'
import { chiefRoster } from './chief.js'
import type { ScopedDb } from './db.js'
import type { WorkspaceScope } from './scope.js'
import { connectors, operationSpecs } from './connectors/index.js'
import { threadDesignSystems } from './designs.js'
import { threadSkills } from './skills.js'
import { gitAccess } from './git.js'
import { folderRules } from './library-folders.js'
import { projectCatalog, threadProject } from './projects.js'
import { accountRef, usableAccounts } from './routes/accounts.js'

/**
 * Harness permission mode for a thread: built-in tools run without asking, on
 * any computer. Brigade does not ask before an action unless the teammate
 * opens a ticket (connector writes are still checked by the API).
 */
function permissionMode(_kind: 'cloud' | 'member_machine'): ThreadSpec['permissionMode'] {
  return 'allow-all'
}

export async function loadThread(db: ScopedDb, id: string) {
  const thread = await db.session.findFirst({
    where: { id },
    include: {
      teammate: true,
      computer: true,
      teammates: { include: { teammate: true }, orderBy: { joinedAt: 'asc' } },
      task: { select: { id: true, title: true, description: true, completedAt: true } },
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
    message: `No ${harness === 'codex' ? 'Codex' : 'Claude'} account of yours on this computer is ready. Add or sign in to one under Accounts.`,
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
  // Each a trip to the database, none waiting on another: asked together.
  const [
    [account, ...fallbacks],
    granted,
    roster,
    rules,
    attachments,
    designSystems,
    project,
    projects,
    [imageAccount],
  ] = await Promise.all([
    usableAccounts(db, {
      memberId: thread.startedByMemberId,
      computerId: thread.computerId,
      provider: teammate.harness,
      preferredId: thread.accountId,
    }),
    // The connections this teammate is granted, as tool specs. Never a credential.
    db.grant.findMany({
      where: { teammateId: teammate.id, connection: { status: { not: 'removed' } } },
      include: {
        connection: { include: { app: { select: { disabledTools: true, mcp: true } } } },
      },
    }),
    teammate.kind === 'chief' ? chiefRoster(db) : [],
    folderRules(db),
    threadAttachments(db, thread.id),
    threadDesignSystems(db, teammate.id, thread.projectId),
    threadProject(db, thread.projectId),
    projectCatalog(db),
    teammate.harness === 'codex'
      ? []
      : usableAccounts(db, {
          memberId: thread.startedByMemberId,
          computerId: thread.computerId,
          provider: 'codex',
        }),
  ])
  // Takeover and terminals need no usage: they may use the thread's current account as is.
  const current =
    account ??
    (options.requireUsage === false && thread.accountId
      ? await db.account.findFirst({ where: { id: thread.accountId, provider: teammate.harness } })
      : null)
  if (!current) throw noAccount(teammate.harness)
  // A member's own account (reach mine) only in the threads they started.
  const grants = granted.filter((g) => usableIn(g.connection, thread))
  const github = grants.some(
    (g) => g.connection.kind === 'github' && g.connection.status === 'active',
  )
  // An MCP connector's tools come from its server; a runner too old to know its kind gets none.
  const protocol = runnerProtocol(thread.computerId)
  const scope = { organizationId: thread.organizationId, workspaceId: thread.workspaceId }
  const specs = await Promise.all(
    grants
      .filter((g) => connectors[g.connection.kind] || g.connection.kind === 'mcp')
      .filter((g) => !isMcp(g.connection.kind) || (protocol ?? MCP_PROTOCOL) >= MCP_PROTOCOL)
      .map(async (g) => ({
        connectionId: g.connection.id,
        // Only kinds with operations get here; a custom app's webhook connection has none. A
        // server added by its URL goes by its tools' prefix, so two of them stay apart.
        kind:
          customMcp(g.connection.app)?.prefix ??
          (g.connection.kind as Exclude<typeof g.connection.kind, 'webhook'>),
        label: g.connection.label,
        externalAccount: g.connection.externalAccount,
        scope: g.scope,
        operations: isMcp(g.connection.kind)
          ? await mcpOperationSpecs(
              db,
              scope,
              g.connection,
              g.scope,
              g.connection.app.disabledTools,
            ).catch((error) => {
              // Signed out or the server is down: the thread runs without its tools.
              console.warn(`mcp tools of ${g.connection.id}: ${String(error)}`)
              return []
            })
          : operationSpecs(g.connection.kind, g.scope, g.connection.app.disabledTools),
      })),
  )
  // An App's skills only for teammates that can use one of its accounts here.
  const skills = await threadSkills(
    db,
    teammate.id,
    thread.projectId,
    new Set(grants.map((g) => g.connection.appId)),
  )
  return {
    connectors: specs,
    account: accountRef(current),
    fallbacks: fallbacks.map(accountRef),
    imageAccount: imageAccount ? accountRef(imageAccount) : null,
    sessionId: thread.id,
    teammate: {
      id: teammate.id,
      name: teammate.name,
      instructions: teammate.instructions,
      harness: teammate.harness,
      model: teammate.model,
      kind: teammate.kind,
    },
    permissionMode: permissionMode(thread.computer.kind),
    starter: teammate.id === thread.teammateId,
    teammates: thread.teammates.map((t) => ({ id: t.teammate.id, name: t.teammate.name })),
    roster,
    library: teammate.libraryAccess,
    libraryFolders: folderExceptions({ id: teammate.id, library: teammate.libraryAccess }, rules),
    private: thread.private,
    attachments,
    task: thread.task
      ? { id: thread.task.id, title: thread.task.title, description: thread.task.description }
      : null,
    designSystems,
    skills,
    project,
    projects,
    // Taken in once by the computer it moved to; older runners ignore it.
    ...(thread.movedAt
      ? {
          moved: {
            at: thread.movedAt.toISOString(),
            from: thread.movedFrom ?? 'another computer',
            seq: thread.movedSeq ?? 0,
          },
        }
      : {}),
    // A GitHub grant also reaches its repositories through git, via the API's proxy.
    ...(github
      ? {
          git: gitAccess(
            { sessionId: thread.id, teammateId: teammate.id, computerId: thread.computerId },
            teammate,
          ),
        }
      : {}),
  }
}

/** Prompting or approving spends the starter's subscription: only they may, unless they allow it. */
export function requireMayPrompt(
  scope: WorkspaceScope,
  thread: {
    startedByMemberId: string
    othersMayPrompt: boolean
    controlledByMemberId: string | null
  },
) {
  if (thread.startedByMemberId !== scope.memberId && !thread.othersMayPrompt) {
    throw new HTTPException(403, {
      message: "This thread runs on another member's subscription. Fork it to continue.",
    })
  }
  if (thread.controlledByMemberId) {
    throw new HTTPException(409, {
      message: 'A person has control of this thread. It continues when they hand it back.',
    })
  }
}
