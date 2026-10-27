// Replacing a workspace's cloud computer with a new VM, for when its VM no longer starts (a
// provider's failed restore, say) or a person wants a fresh one. The computer stays the same row,
// so its threads, accounts and queued commands stay its own; only its VM changes. The steps are
// kept on a row (ComputerReplacement), so an API restart picks them up where they were:
//   backing_up  the old VM's runner, if it answers, backs up what lives only on its disk
//               (computer.backup), then the old VM is stopped. It is never destroyed: Brigade
//               keeps its reference on the row, and its data can still be read at the provider.
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
import { broadcastComputer, dropRunner, isOnline, runnerProtocol, sendToRunner } from './hub.js'
import { noteFailure } from './ops/failures.js'

/** Longest the old computer may take to back itself up before it is replaced anyway. */
const BACKUP_TIMEOUT_MS = 20 * 60_000
/** What a member reads of where the thread came from (ThreadSpec.moved). */
const MOVED_FROM = 'the cloud computer this one replaced'
const OPEN_PHASES = ['backing_up', 'creating', 'restoring']

type Replacement = Prisma.ComputerReplacementGetPayload<object>

const pendingBackups = new Map<
  string,
  { computerId: string; resolve: (result: { ok: boolean; error?: string }) => void }
>()

/**
 * Ask a cloud computer's runner to back up everything now; resolves once it says it is done,
 * when it goes offline, or after `timeoutMs` (ok: false then). Not for runners before
 * BACKUP_PROTOCOL: they have nothing to back up with.
 */
export function backupComputer(
  computerId: string,
  timeoutMs = BACKUP_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  if ((runnerProtocol(computerId) ?? 0) < BACKUP_PROTOCOL)
    return Promise.resolve({ ok: false, error: 'its runner cannot back up' })
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ ok: false, error: 'it took too long' }), timeoutMs)
    const offline = setInterval(() => {
      if (!isOnline(computerId)) finish({ ok: false, error: 'its runner went offline' })
    }, 5_000)
    const finish = (result: { ok: boolean; error?: string }) => {
      clearTimeout(timer)
      clearInterval(offline)
      pendingBackups.delete(requestId)
      resolve(result)
    }
    pendingBackups.set(requestId, { computerId, resolve: finish })
    // Backing up is no use of the computer: it does not postpone its idle stop.
    if (!sendToRunner(computerId, { type: 'computer.backup', requestId }, { touch: false }))
      finish({ ok: false, error: 'its runner is offline' })
  })
}

/** A runner answered computer.backup. */
export function onBackupResult(
  computerId: string,
  result: { requestId: string; ok: boolean; error?: string | undefined },
) {
  const pending = pendingBackups.get(result.requestId)
  if (pending?.computerId !== computerId) return
  pending.resolve({ ok: result.ok, ...(result.error ? { error: result.error } : {}) })
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
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cloud:${scope.workspaceId}`}))`
    const computer = await tx.computer.findFirst({
      where: { id: computerId, ...scope, kind: 'cloud', status: { not: 'destroyed' } },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    if (!computer.providerRef || isProvisioning(computer.id))
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
  broadcastComputer(scope.workspaceId, computerId)
  void drive(row.id)
  return row
}

/** Replacements this process is moving on, by id: one at a time each. */
const driving = new Set<string>()

/** Move a replacement on as far as it goes now. A failure is kept on its row; the minute job tries again. */
async function drive(id: string) {
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
    if (isOnline(computer.id)) {
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
  dropRunner(computer.id)
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
    await moveThreads(tx, computer.id, row.memberId)
  })
  broadcastComputer(computer.workspaceId, computer.id, 'creating')
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

/** When each computer's making was last started again here (keepCreating), by id. */
const remade = new Map<string, number>()
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
  const [teammates, accounts] = await Promise.all([
    prisma.teammateBackup.findMany({
      where: { workspaceId: row.workspaceId },
      distinct: ['teammateId'],
      select: { teammateId: true },
    }),
    prisma.accountLoginBackup.findMany({
      where: { account: { computerId } },
      select: { accountId: true },
    }),
  ])
  return {
    id: row.id,
    teammateIds: teammates.map((t) => t.teammateId),
    accountIds: accounts.map((a) => a.accountId),
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
  broadcastComputer(runner.workspaceId, runner.computerId)
}

/** Each minute: replacements an API restart or a passing failure left under way go on. */
export async function driveReplacements() {
  const open = await prisma.computerReplacement.findMany({
    where: { phase: { in: ['backing_up', 'creating'] } },
    select: { id: true },
  })
  for (const { id } of open) await drive(id)
}
