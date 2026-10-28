// Replacing a workspace's cloud computer with a new VM, for when its VM no longer starts (a
// provider's failed restore, say) or a person wants a fresh one. The computer stays the same row,
// so its threads, accounts and queued commands stay its own; only its VM changes. The steps are
// kept on a row (ComputerReplacement), so an API restart picks them up where they were:
//   backing_up  the old VM's runner, if it answers, backs up what lives only on its disk
//               (computer.backup), then the old VM is stopped. It is never destroyed: Brigade
//               keeps its reference on the row, and its data can still be read at the provider.
//               Its accounts whose login was never backed up need signing in again.
//   creating    a new VM, its runner installed (cloud.ts's provision, as for a new computer).
//               Every thread of the computer "moves" to it (Session.moved): its next turn takes in
//               its folder from its latest backup, and the conversation from its events.
//   restoring   the new runner's welcome asks it to put back what its teammates had there
//               (account logins, crontabs, user services, browser profiles) before anything runs;
//               it answers computer.restored with what could not come back.
//   done / failed
// Each runner backs up on its own as it goes (thread folders every few minutes, logins as they
// change), and before each idle stop (cloud.ts): a VM lost suddenly costs only minutes of work.
import { randomUUID } from 'node:crypto'
import { BACKUP_PROTOCOL } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { requireCloudPlan } from './billing.js'
import { isProvisioning, startProvision, stopOldVm } from './cloud.js'
import { Prisma, prisma, type Scope } from './db.js'
import { BEING_DELETED, beingDeleted } from './deletion-fence.js'
import { hubs } from './hub.js'
import { currentHub } from './hub/context.js'
import { noteFailure } from './ops/failures.js'

/** Longest the old computer may take to back itself up before it is replaced anyway. */
const BACKUP_TIMEOUT_MS = 20 * 60_000
/** What a member reads of where the thread came from (ThreadSpec.moved). */
const MOVED_FROM = 'the cloud computer this one replaced'
const OPEN_PHASES = ['backing_up', 'creating', 'restoring']

type Replacement = Prisma.ComputerReplacementGetPayload<object>

/**
 * In the hub: ask a cloud computer's runner to back up everything now; resolves once it says it
 * is done, when it goes offline, or after `timeoutMs` (ok: false then). Not for runners before
 * BACKUP_PROTOCOL: they have nothing to back up with.
 */
export async function backupComputer(
  computerId: string,
  timeoutMs = BACKUP_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const hub = currentHub()
  if ((hub.runnerProtocol(computerId) ?? 0) < BACKUP_PROTOCOL)
    return { ok: false, error: 'its runner cannot back up' }
  // Backing up is no use of the computer: it does not postpone its idle stop.
  const answer = await hub.askRunner(
    computerId,
    { type: 'computer.backup', requestId: randomUUID() },
    timeoutMs,
    { touch: false, offline: 'its runner is offline' },
  )
  if ('error' in answer && !('type' in answer))
    return {
      ok: false,
      error:
        answer.error === 'The computer did not answer'
          ? 'it took too long'
          : answer.error === 'The computer went offline'
            ? 'its runner went offline'
            : answer.error,
    }
  if (answer.type !== 'computer.backup.result') return { ok: false, error: 'unexpected answer' }
  return { ok: answer.ok, ...(answer.error ? { error: answer.error } : {}) }
}

/** The computer's replacement under way, if any. */
export const openReplacement = (computerId: string) =>
  prisma.computerReplacement.findFirst({
    where: { computerId, phase: { in: OPEN_PHASES } },
    orderBy: { createdAt: 'desc' },
  })

/** Whether the computer's new VM has yet to put its backups back: what it has is not what to keep. */
export async function restoring(computerId: string) {
  const open = await openReplacement(computerId)
  return open?.phase === 'creating' || open?.phase === 'restoring'
}

/** Its latest replacement, for the dashboard: where it is, and what did not come back. */
export async function lastReplacement(computerId: string) {
  const row = await prisma.computerReplacement.findFirst({
    where: { computerId },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return null
  return {
    id: row.id,
    phase: row.phase,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    backup: row.backup,
    problems: Array.isArray(row.problems) ? (row.problems as { text: string }[]) : [],
    error: row.error,
  }
}

/** A member asks for the workspace's cloud computer on a new VM. */
export async function replaceComputer(scope: Scope, computerId: string, memberId: string) {
  await requireCloudPlan(scope.workspaceId)
  const hub = hubs.get(scope.workspaceId)
  const making = await hub.isProvisioning(computerId)
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cloud:${scope.workspaceId}`}))`
    if (await beingDeleted(scope.workspaceId, tx))
      throw new HTTPException(409, { message: BEING_DELETED })
    const computer = await tx.computer.findFirst({
      where: { id: computerId, ...scope, kind: 'cloud', status: { not: 'destroyed' } },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    if (!computer.providerRef || making)
      throw new HTTPException(409, { message: 'This cloud computer is still being made' })
    const open = await tx.computerReplacement.findFirst({
      where: { computerId, phase: { in: OPEN_PHASES } },
    })
    if (open) throw new HTTPException(409, { message: 'This cloud computer is being replaced' })
    return tx.computerReplacement.create({
      data: { ...scope, computerId, memberId, phase: 'backing_up' },
    })
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: memberId },
    action: 'computer.replace_requested',
    target: { type: 'computer', id: computerId },
    data: { replacementId: row.id },
  })
  void hub.broadcastComputer(computerId)
  void hub.driveReplacement(row.id)
  return row
}

/** What the running hub keeps of its replacements. */
const state = () =>
  currentHub().local('cloud-replace', () => ({
    /** Replacements it is moving on, by id: one at a time each. */
    driving: new Set<string>(),
    /** When each computer's making was last started again (keepCreating), by id. */
    remade: new Map<string, number>(),
  }))

/**
 * In the hub: move a replacement on as far as it goes now. A failure is kept on its row; the
 * minute job tries again.
 */
export async function drive(id: string) {
  const { driving } = state()
  if (driving.has(id)) return
  driving.add(id)
  try {
    const row = await prisma.computerReplacement.findUnique({ where: { id } })
    if (!row) return
    if (row.phase === 'backing_up') await backUpAndSwitch(row)
    else if (row.phase === 'creating') await keepCreating(row)
  } catch (error) {
    console.error(`replacing computer (${id}) failed for now`, error)
    noteFailure('cloud-replace', error)
    await prisma.computerReplacement
      .update({ where: { id }, data: { error: String(error).slice(0, 2000) } })
      .catch(() => undefined)
  } finally {
    driving.delete(id)
  }
}

/** The old computer's last backup, if it answers, then the switch to a new VM. */
async function backUpAndSwitch(row: Replacement) {
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: row.computerId } })
  if (!row.backup) {
    let note: string
    if (currentHub().isOnline(computer.id)) {
      const result = await backupComputer(computer.id)
      note = result.ok ? 'backed up' : `not backed up: ${result.error ?? 'unknown error'}`
    } else note = 'not backed up: it was offline, its latest backups are used'
    await prisma.computerReplacement.update({ where: { id: row.id }, data: { backup: note } })
    console.log(`replacing ${computer.id}: the old computer was ${note}`)
  }
  const ref = computer.providerRef
  // Stopped, so that nothing runs there with the threads' logins any more: two computers
  // refreshing one login sign each other out. One that does not run (it no longer starts, say)
  // stays as it is; one still running that will not stop holds the replacement back, tried again.
  if (ref) await stopOldVm(ref as never)
  currentHub().dropRunner(computer.id)
  await prisma.$transaction(async (tx) => {
    // Kept on the row, never destroyed: provision() destroys only the computer's own reference.
    await tx.computerReplacement.update({
      where: { id: row.id },
      data: {
        phase: 'creating',
        ...(ref ? { oldProviderRef: ref as Prisma.InputJsonValue } : {}),
      },
    })
    await tx.computer.update({
      where: { id: computer.id },
      data: { providerRef: Prisma.DbNull, status: 'creating' },
    })
    // The old runner's token goes: nothing there connects as this computer any more.
    await tx.runner.deleteMany({ where: { computerId: computer.id } })
    // A login never backed up stays on the old VM: its account is signed in again on the new
    // one, rather than shown ready while every turn there fails with "Not logged in".
    await tx.account.updateMany({
      where: {
        computerId: computer.id,
        source: 'brigade',
        status: { not: 'needs_sign_in' },
        loginBackup: { is: null },
      },
      data: { status: 'needs_sign_in' },
    })
    await moveThreads(tx, computer.id, row.memberId)
  })
  currentHub().broadcastComputer(computer.id, 'creating')
  await audit({
    organizationId: computer.organizationId,
    workspaceId: computer.workspaceId,
    actor: { type: 'system', id: 'brigade' },
    action: 'computer.replaced',
    target: { type: 'computer', id: computer.id },
    data: { replacementId: row.id, backup: row.backup ?? null },
  })
  startProvision(computer)
}

/**
 * Every thread of the computer comes to its new VM as if moved there (move.ts's arrive): its
 * next turn there takes its folder in from its backup and its conversation from its events,
 * numbered after the last one. What ran on the old VM ended there; a thread that was at work
 * gets a nudge to carry on once the new runner is up (move.ts, movesOn).
 */
async function moveThreads(tx: Prisma.TransactionClient, computerId: string, memberId: string) {
  const at = new Date()
  const arriving = {
    to: computerId,
    phase: 'arriving',
    by: memberId,
    since: at.toISOString(),
  }
  await tx.$executeRaw`
    UPDATE "Session" s
    SET "movedSeq" = GREATEST(s."lastSeq", COALESCE((SELECT max(e.seq) FROM "SessionEvent" e WHERE e."sessionId" = s.id), 0)),
        "lastSeq" = GREATEST(s."lastSeq", COALESCE((SELECT max(e.seq) FROM "SessionEvent" e WHERE e."sessionId" = s.id), 0)),
        "movedAt" = ${at},
        "movedFrom" = ${MOVED_FROM},
        "move" = CASE WHEN s.status IN ('starting', 'running', 'waiting') AND s.move IS NULL
                      THEN ${JSON.stringify(arriving)}::jsonb ELSE s.move END,
        "status" = CASE WHEN s.status IN ('starting', 'running', 'waiting')
                        THEN 'idle'::"SessionStatus" ELSE s.status END
    WHERE s."computerId" = ${computerId}`
}

/** A making that failed is started again after this. */
const REMAKE_EVERY_MS = 10 * 60_000

/**
 * Being made: started again when nothing makes it, after an API restart or a failure (each
 * making starts from a new VM, the one it may have made going first: it holds nothing yet).
 */
async function keepCreating(row: Replacement) {
  if (isProvisioning(row.computerId)) return
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: row.computerId } })
  const runner = await prisma.runner.findUnique({ where: { computerId: computer.id } })
  // Installed: its runner's hello moves the replacement on (restoreFor).
  if (runner) return
  const { remade } = state()
  if (Date.now() - (remade.get(computer.id) ?? 0) < REMAKE_EVERY_MS) return
  remade.set(computer.id, Date.now())
  startProvision(computer)
}

/**
 * The computer's runner says hello: if it is the new VM of a replacement, what to put back
 * before anything runs there (the welcome's restore), each time until it says it has.
 */
export async function restoreFor(computerId: string) {
  const row = await openReplacement(computerId)
  if (!row || row.phase === 'backing_up') return undefined
  if (row.phase === 'creating')
    await prisma.computerReplacement.update({
      where: { id: row.id },
      data: { phase: 'restoring', error: null },
    })
  const [teammates, accounts, folders] = await Promise.all([
    prisma.teammateBackup.findMany({
      where: { workspaceId: row.workspaceId },
      distinct: ['teammateId'],
      select: { teammateId: true },
    }),
    prisma.accountLoginBackup.findMany({
      where: { account: { computerId } },
      select: { accountId: true },
    }),
    prisma.folderBackup.findMany({
      where: { session: { computerId } },
      select: { sessionId: true, teammateId: true },
    }),
  ])
  return {
    id: row.id,
    teammateIds: teammates.map((t) => t.teammateId),
    accountIds: accounts.map((a) => a.accountId),
    folders,
  }
}

/** The new runner put the backups back: the replacement is done, with what did not come back. */
export async function onRestored(
  runner: Scope & { computerId: string },
  message: { id: string; problems: { teammateId?: string | undefined; text: string }[] },
) {
  const row = await prisma.computerReplacement.findFirst({
    where: { id: message.id, computerId: runner.computerId, phase: 'restoring' },
  })
  if (!row) return
  await prisma.computerReplacement.update({
    where: { id: row.id },
    data: {
      phase: 'done',
      finishedAt: new Date(),
      problems: message.problems as Prisma.InputJsonValue,
      error: null,
    },
  })
  await audit({
    ...runner,
    actor: { type: 'system', id: 'brigade' },
    action: 'computer.restored',
    target: { type: 'computer', id: runner.computerId },
    data: { replacementId: row.id, problems: message.problems.length },
  })
  currentHub(runner.workspaceId).broadcastComputer(runner.computerId)
}

/**
 * Each minute: replacements an API restart or a passing failure left under way go on, each in
 * its workspace's hub.
 */
export async function driveReplacements(workspaceId?: string) {
  const open = await prisma.computerReplacement.findMany({
    where: { phase: { in: ['backing_up', 'creating'] }, ...(workspaceId ? { workspaceId } : {}) },
    select: { id: true, workspaceId: true },
  })
  for (const { id, workspaceId: owner } of open) await hubs.get(owner).driveReplacement(id)
}

/** Workspaces with a replacement under way (src/jobs.ts). */
export async function dueReplacements() {
  const rows = await prisma.computerReplacement.findMany({
    where: { phase: { in: ['backing_up', 'creating'] } },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}
