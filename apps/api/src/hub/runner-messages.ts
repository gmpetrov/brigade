// A runner's messages, as its workspace's hub takes them (src/hub/workspace-hub.ts): one at a
// time per connection, in the order sent. Runs in the hub, wherever that is: the API's process,
// or the workspace's Durable Object (docs/workspace-hubs-plan.md).
import {
  BACKUP_PROTOCOL,
  DIRECT_UPLOAD_PROTOCOL,
  MIN_PROTOCOL_VERSION,
  RESUME_PROTOCOL,
  RunnerToApi,
  type AgentEvent,
  type ApiToRunner,
  type SequencedEvent,
} from '@brigade/contracts'
import { trackTurns } from '../analytics.js'
import { handlePreviewCall, handlePreviewExpose, notePreviewEvents } from '../app-previews.js'
import { audit } from '../audit.js'
import { noteChildEvents } from '../children.js'
import { ensureSetup, giveHomesBackOnceRestored, stopWithoutPlan } from '../cloud.js'
import { onRestored, restoreFor } from '../cloud-replace.js'
import { handleConnectorCall } from '../connector-calls.js'
import { handleCredentialRequest } from '../credentials.js'
import { prisma, type Prisma } from '../db.js'
import { beingDeleted } from '../deletion-fence.js'
import { noteDisk } from '../disk-tickets.js'
import { keepFilesApart } from '../event-files.js'
import { dropDeadWaiters, type Live } from '../held-calls.js'
import type { Session } from '../generated/prisma/client.js'
import type { SessionStatus } from '../generated/prisma/enums.js'
import { bringBackFromLater } from '../later.js'
import { reopenThread } from '../thread-done.js'
import { handleLibraryCall, handleMemoryTidy, handleMemoryUpdate } from '../library-calls.js'
import { endLogin, loginById, loginsOnComputer, updateLogin } from '../logins.js'
import { noteMailLeft } from '../mail/outcomes.js'
import { movesOn, onReleased } from '../move.js'
import { noteFailure } from '../ops/failures.js'
import { noteDryRunEvents } from '../playbook-dry-runs.js'
import { messagesToRequeue, turnsToResume } from '../recovery.js'
import { runnerBundle } from '../routes/runner-install.js'
import { handleScheduleCall } from '../schedules.js'
import { packCommand, takesParts } from '../spec-parts.js'
import { readableEvents, storableForms, storableJson } from '../storable-json.js'
import { handleTaskCall } from '../tasks.js'
import { noteLoggedResponses, noteTokenUsage, noteUsageRun } from '../usage.js'
import { handoffThread, titleThread } from '../work.js'
import type { RunnerConn } from './host.js'
import {
  NOTE_RETRY_MS,
  noteEvents,
  noteTurnsEnded,
  queuedMessagesOn,
  statusAfter,
  syncMachineLogins,
  withTeammateIds,
} from './thread-events.js'
import type { WorkspaceHub } from './workspace-hub.js'

/** How stale the heard time kept with a runner's socket may be: well under SILENT_MS. */
export const HEARD_KEEP_MS = 15_000

/** The runner a connection is, as the modules it calls name it. */
const runnerOf = (conn: RunnerConn) => ({
  id: conn.runnerId,
  computerId: conn.computerId,
  organizationId: conn.organizationId,
  workspaceId: conn.workspaceId,
})

/** A runner's message: heard now, taken once those before it are. */
export function onRunnerMessage(hub: WorkspaceHub, conn: RunnerConn, raw: string) {
  conn.heardAt = Date.now()
  if (conn.heardAt - (conn.heardKept ?? 0) >= HEARD_KEEP_MS) {
    conn.heardKept = conn.heardAt
    hub.host.persist(conn)
  }
  conn.queue = conn.queue
    .then(() => handle(hub, conn, raw))
    .catch((error) => console.error('runner message failed', error))
  return conn.queue
}

/** A runner's connection closed: what waited on it is told, unless another took over. */
export function onRunnerClose(hub: WorkspaceHub, conn: RunnerConn) {
  if (!hub.runnerClosed(conn)) return
  const { computerId } = conn
  // Calls held for a person stop waiting on this connection: their result goes to the thread.
  dropDeadWaiters()
  // Its threads' events wait on it now, as its computer shows: it says again once back.
  const waited = hub.forgetEventsWaiting(computerId)
  if (waited.length) void hub.broadcastEventsWaiting(waited).catch(console.error)
  hub.broadcastComputer(computerId)
  // A thread waiting to leave it leaves without its folders.
  void movesOn(computerId).catch(console.error)
}

async function handle(hub: WorkspaceHub, conn: RunnerConn, raw: string) {
  const runner = runnerOf(conn)
  const send = (message: ApiToRunner) => hub.send(conn, message)
  const json = JSON.parse(raw) as { callId?: unknown }
  const parsed = RunnerToApi.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    console.warn('bad runner message', issue)
    const events = conn.protocolVersion !== undefined && readableEvents(json)
    if (events) return storeAll(hub, conn, events)
    // A call the runner waits on is answered, or the teammate's tool would wait forever.
    if (typeof json?.callId === 'string')
      send({
        type: 'connector.result',
        callId: json.callId,
        ok: false,
        error: `Brigade could not read this call (${issue?.path.join('.') || 'message'}: ${issue?.message}). Try again differently.`,
      })
    return
  }
  const message = parsed.data

  if (message.type === 'hello') return hello(hub, conn, message)
  if (conn.protocolVersion === undefined) return // must say hello first
  // Heard, which is all they say (onRunnerMessage).
  if (message.type === 'heartbeat' || message.type === 'keepalive') return
  if (message.type === 'runner.restarting') {
    // Its threads say their computer is restarting, rather than look at work.
    return hub.noteRestarting(runner.computerId, conn.protocolVersion)
  }

  if (message.type === 'events.waiting') return noteEventsWaiting(hub, conn, message.threads)

  if (message.type === 'command.ack') {
    const { ackCommands } = await import('../runner-commands.js')
    return ackCommands(runner.computerId, message.commandIds)
  }

  // An answer to a request waiting on it (askRunner): file reads, previews, backups…
  if (hub.answered(runner.computerId, message)) return

  if (message.type === 'computer.restored')
    return onRestored(runner, message).catch((error) =>
      console.error(`restore report from ${runner.computerId} failed`, error),
    )

  if (message.type === 'disk')
    return noteDisk(runner, message).catch((error) =>
      console.error(`disk report from ${runner.computerId} failed`, error),
    )

  if (message.type === 'events') return storeAll(hub, conn, message.events)

  if (message.type === 'account.login.prompt' || message.type === 'account.login.done')
    return noteLogin(hub, conn, message)

  // A call held for a person hears its result on this connection while it is still the computer's.
  const live: Live = { computerId: runner.computerId, connectionId: conn.id }
  const failed = (callId: string) => (error: unknown) =>
    send({
      type: 'connector.result',
      callId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })

  if (message.type === 'credential.request') {
    // May wait for a person, like a connector call.
    void handleCredentialRequest(runner, message, send, { live }).catch(failed(message.callId))
    return
  }

  if (message.type === 'task.call') {
    void handleTaskCall(runner, message, send).catch(failed(message.callId))
    return
  }

  if (message.type === 'schedule.call') {
    void handleScheduleCall(runner, message, send, { live }).catch(failed(message.callId))
    return
  }

  if (message.type === 'library.call') {
    void handleLibraryCall(runner, message, send).catch(failed(message.callId))
    return
  }

  if (message.type === 'memory.update') {
    void handleMemoryUpdate(runner, message).catch((error) =>
      console.warn(`runner ${runner.id}: memory update failed: ${String(error)}`),
    )
    return
  }

  if (message.type === 'memory.tidy') {
    void handleMemoryTidy(runner, message).catch((error) =>
      console.warn(`runner ${runner.id}: memory tidy failed: ${String(error)}`),
    )
    return
  }

  if (message.type === 'thread.title') {
    void titleThread(runner, message).catch((error) =>
      console.warn(`runner ${runner.id}: thread title failed: ${String(error)}`),
    )
    return
  }

  if (message.type === 'usage.responses') {
    // Answered once kept: the runner then moves past them in its logs, else reads them again.
    void noteLoggedResponses(runner, message.responses).then(
      () => send({ type: 'connector.result', callId: message.callId, ok: true }),
      (error: unknown) => {
        console.warn(`runner ${runner.id}: usage of a turn's responses not kept: ${String(error)}`)
        send({
          type: 'connector.result',
          callId: message.callId,
          ok: false,
          error: 'Usage not kept; it is sent again later',
        })
      },
    )
    return
  }

  if (message.type === 'usage.run') {
    void noteUsageRun(runner, message).catch((error) =>
      console.warn(
        `runner ${runner.id}: usage of a ${message.kind} run not kept: ${String(error)}`,
      ),
    )
    return
  }

  if (message.type === 'thread.handoff') {
    // Sent when the teammate's turn ends; caps and the chain limit are checked there.
    void handoffThread(runner, message).catch((error) =>
      console.warn(`runner ${runner.id}: handoff failed: ${String(error)}`),
    )
    return
  }

  if (message.type === 'connector.call') {
    // Long-running (it may wait for a person): do not block the runner's other messages.
    void handleConnectorCall(runner, message, send, { live }).catch(failed(message.callId))
    return
  }

  if (message.type === 'preview.call') {
    void handlePreviewCall(runner, message, send).catch(failed(message.callId))
    return
  }

  if (message.type === 'preview.expose') {
    void handlePreviewExpose(runner, message, send).catch(failed(message.callId))
    return
  }

  if (message.type === 'thread.release.result') return onReleased(runner, message)

  if (message.type === 'terminal.output' || message.type === 'terminal.exit') {
    const relay = hub.terminalOf(message.terminalId)
    if (!relay || relay.terminal.computerId !== runner.computerId) return
    if (message.type === 'terminal.exit') hub.removeTerminal(relay.conn, message.terminalId)
    hub.send(relay.conn, message)
    return
  }

  if (message.type === 'command.failed')
    console.warn(`runner ${runner.id}: command ${message.commandId} failed: ${message.error}`)
}

/** A runner said hello: it is its computer's connection now, and is told what to carry on. */
async function hello(
  hub: WorkspaceHub,
  conn: RunnerConn,
  message: Extract<RunnerToApi, { type: 'hello' }>,
) {
  const runner = runnerOf(conn)
  const send = (m: ApiToRunner) => hub.send(conn, m)
  const bundle = (await runnerBundle()) ?? undefined
  if (message.protocolVersion < MIN_PROTOCOL_VERSION) {
    send({
      type: 'update.required',
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      ...(bundle ? { bundle } : {}),
    })
    conn.socket.close(4000, 'update required')
    return
  }
  conn.protocolVersion = message.protocolVersion
  if (message.startedAt) conn.startedAt = message.startedAt
  if (message.bundle) conn.bundle = message.bundle
  if (bundle) conn.offered = bundle
  // Back from an update: what waited for it is sent below (flushQueue).
  hub.takeOver(conn)
  await prisma.runner.update({
    where: { id: runner.id },
    data: {
      // The installed bundle tells builds apart; the package version does not change.
      version: message.bundle
        ? `${message.version}+${message.bundle.slice(0, 12)}`
        : message.version,
      protocolVersion: message.protocolVersion,
      platform: message.platform,
      lastSeenAt: new Date(),
    },
  })
  const computer = await prisma.computer.update({
    where: { id: runner.computerId },
    data: {
      status: 'running',
      // Runners linked before machine IDs say theirs here, so a later link finds this computer.
      ...(message.machineId ? { machineId: message.machineId } : {}),
    },
  })
  // Its workspace's plan ended meanwhile (src/billing.ts): stopped, not given work.
  if (await stopWithoutPlan(computer).catch(() => false)) return
  // Previews its previous process ran are gone (app-previews.ts): lists that mark them
  // (the sidebar's threads, pull requests) fetch again.
  if (message.startedAt) hub.notifyList('pulls.updated')
  // A cloud computer set up by an older bootstrap gets the current root setup.
  // Then, once a resumed one's disk is all there, its teammates' homes are theirs again,
  // with the setup's helper.
  if (computer.kind === 'cloud')
    void ensureSetup(computer, message.setup)
      .catch((error) => console.error(`setup on ${computer.id} failed`, error))
      .then(() => giveHomesBackOnceRestored(computer))
      .catch((error) => console.error(`giving homes back on ${computer.id} failed`, error))
  if (computer.kind === 'member_machine' && computer.memberId && message.machineLogins) {
    await syncMachineLogins(computer, computer.memberId, message.machineLogins)
  }
  // A runner that reconnects has lost any sign-in it was running. Those this hub never knew
  // (it restarted meanwhile) end too: an account is never left signing in.
  const known = new Set(loginsOnComputer(runner.computerId).map((l) => l.accountId))
  await prisma.account.updateMany({
    where: {
      computerId: runner.computerId,
      status: 'signing_in',
      ...(known.size ? { id: { notIn: [...known] } } : {}),
    },
    data: { status: 'needs_sign_in' },
  })
  for (const login of loginsOnComputer(runner.computerId)) {
    endLogin(login.loginId)
    await prisma.account.updateMany({
      where: { id: login.accountId, status: 'signing_in' },
      data: { status: 'needs_sign_in' },
    })
    hub.sendToMember(login.memberId, {
      type: 'account.login',
      accountId: login.accountId,
      state: 'failed',
      error: 'The computer restarted during sign-in. Sign in again.',
    })
  }
  // Turns and queued messages a restart may have cut off: the runner continues those it
  // lost (an older one closes and cancels them). Waiting threads too: a turn waiting on
  // a connector call's approval was still running there.
  // Its workspace is being deleted (src/deletion-fence.ts): nothing goes on, and nothing is
  // dropped either. Told of no thread, the runner neither resumes, requeues, cancels nor
  // closes one; its queued messages stay as they are, for a hello once the deletion failed.
  const fenced = await beingDeleted(runner.workspaceId)
  if (fenced !== Boolean(conn.heldBack)) {
    conn.heldBack = fenced
    hub.host.persist(conn)
  }
  const inProgress = await prisma.session.findMany({
    where: { computerId: runner.computerId, status: { in: ['running', 'waiting'] } },
    select: { id: true, status: true },
  })
  const runningThreads = inProgress.filter((s) => s.status === 'running').map((s) => s.id)
  const queuedMessages = await queuedMessagesOn(runner.computerId)
  const resumes = message.protocolVersion >= RESUME_PROTOCOL
  // The new VM of a replacement puts back what the old one had, before anything runs.
  const restore =
    computer.kind === 'cloud' && message.protocolVersion >= BACKUP_PROTOCOL
      ? await restoreFor(runner.computerId)
      : undefined
  // A runner installed from another bundle updates itself once it is idle.
  const welcome: ApiToRunner = {
    type: 'welcome',
    runnerId: runner.id,
    computerId: runner.computerId,
    // Its workspace: the runner connects to its hub with it from now on.
    workspaceId: runner.workspaceId,
    ...(bundle ? { bundle } : {}),
    runningThreads: fenced ? [] : runningThreads,
    queuedMessages: fenced
      ? []
      : queuedMessages.map(({ sessionId, messageId }) => ({ sessionId, messageId })),
    ...(resumes && !fenced
      ? {
          resume: await turnsToResume(
            runner,
            inProgress.map((s) => s.id),
          ),
          requeue: await messagesToRequeue(runner, queuedMessages),
        }
      : {}),
    ...(restore ? { restore } : {}),
  }
  // Its specs' large parts by hash, for a runner that fetches them.
  send(
    takesParts(message.protocolVersion)
      ? await packCommand(runner.workspaceId, welcome).catch((error: unknown) => {
          // Whole, then: larger, but the runner still gets its welcome.
          console.error(`welcome of ${runner.computerId} not packed: ${String(error)}`)
          return welcome
        })
      : welcome,
  )
  if (message.bundle && bundle && message.bundle !== bundle)
    console.log(
      `runner ${runner.id}: bundle ${message.bundle.slice(0, 12)} → ${bundle.slice(0, 12)}`,
    )
  hub.touch(runner.computerId)
  await hub.flushQueue(runner.computerId, conn)
  // Running now, as written above: a status a dashboard kept (stopped, error) is over.
  hub.broadcastComputer(runner.computerId, computer.status)
  // Threads that moved here while it was offline get their message now; not while its
  // workspace is being deleted, as that message starts a turn: on its next hello.
  if (!fenced) void movesOn(runner.computerId).catch(console.error)
}

/** A sign-in the runner runs said where it stands: its member hears it. */
async function noteLogin(
  hub: WorkspaceHub,
  conn: RunnerConn,
  message: Extract<RunnerToApi, { type: 'account.login.prompt' | 'account.login.done' }>,
) {
  const login = loginById(message.loginId)
  if (!login || login.computerId !== conn.computerId) return
  if (message.type === 'account.login.prompt') {
    const last = {
      type: 'account.login' as const,
      accountId: login.accountId,
      state: 'open_url' as const,
      url: message.url,
      flow: message.flow,
      ...(message.userCode ? { userCode: message.userCode } : {}),
    }
    updateLogin(login.loginId, { last })
    hub.sendToMember(login.memberId, last)
    return
  }
  endLogin(login.loginId)
  if (message.ok) {
    const resolved = await prisma.ticket.updateManyAndReturn({
      where: {
        type: 'sign_in',
        status: 'open',
        workspaceId: hub.workspaceId,
        payload: { path: ['accountId'], equals: login.accountId },
      },
      data: { status: 'resolved', resolvedByMemberId: login.memberId, resolvedAt: new Date() },
      select: { workspaceId: true },
    })
    if (resolved.length) hub.notifyList('tickets.updated')
  }
  await prisma.account.update({
    where: { id: login.accountId },
    data: message.ok
      ? {
          status: 'ready',
          exhaustedUntil: null,
          // A token cannot tell whose it is: the member may have said.
          email: message.email ?? login.email ?? null,
          plan: message.plan ?? null,
        }
      : { status: 'needs_sign_in' },
  })
  await audit({
    organizationId: conn.organizationId,
    workspaceId: conn.workspaceId,
    actor: { type: 'member', id: login.memberId },
    action: message.ok ? 'account.signed_in' : 'account.sign_in_failed',
    target: { type: 'account', id: login.accountId },
  })
  hub.sendToMember(login.memberId, {
    type: 'account.login',
    accountId: login.accountId,
    state: message.ok ? 'done' : 'failed',
    ...(message.error ? { error: message.error } : {}),
  })
}

/** A runner that uploads files itself still sent one inline: said once per connection. */
function noteInlineFiles(conn: RunnerConn) {
  if (conn.warnedInline || (conn.protocolVersion ?? 0) < DIRECT_UPLOAD_PROTOCOL) return
  conn.warnedInline = true
  console.warn(
    `runner ${conn.runnerId} (protocol ${conn.protocolVersion}) sent a file inline in its events`,
  )
}

async function storeAll(hub: WorkspaceHub, conn: RunnerConn, events: SequencedEvent[]) {
  // One thread's events failing to store must not hold back the others' in the batch.
  for (const [sessionId, ofThread] of Map.groupBy(events, (e) => e.sessionId))
    await storeEvents(hub, conn, sessionId, ofThread).catch((error) =>
      console.error(
        `runner ${conn.runnerId}: could not store events of thread ${sessionId}`,
        error,
      ),
    )
}

async function storeEvents(
  hub: WorkspaceHub,
  conn: RunnerConn,
  sessionId: string,
  events: SequencedEvent[],
) {
  hub.touch(conn.computerId)
  // A runner may only write events for threads on its own computer.
  const session = await prisma.session.findFirst({
    where: { id: sessionId, computerId: conn.computerId },
  })
  if (!session) {
    console.warn(`runner ${conn.runnerId} sent events for a thread it does not run`)
    // Acknowledged all the same, never stored: or it sends them again every half minute.
    const last = Math.max(...events.map((e) => e.seq))
    return hub.send(conn, { type: 'ack', sessionId, seq: last })
  }
  await insertEvents(conn, session, await withTeammateIds(session, events))
  await advance(hub, conn, session)
}

/**
 * Store a thread's events. One the database refuses is stored in a lesser form
 * (storableForms), never left out: lastSeq only moves over a contiguous run, so
 * every event after it would wait on it, and the thread with them.
 */
async function insertEvents(
  conn: RunnerConn,
  session: { id: string; organizationId: string; workspaceId: string },
  events: SequencedEvent[],
) {
  const rows = (seq: number, event: AgentEvent) => ({
    organizationId: session.organizationId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    seq,
    type: event.type,
    data: event as unknown as Prisma.InputJsonValue,
    at: new Date(event.at),
  })
  // Images and PDFs go to the bucket, not the database (event-files.ts). Runners from
  // DIRECT_UPLOAD_PROTOCOL on put them there first and send only their names.
  const kept = await Promise.all(
    events.map(async ({ seq, event }) => {
      const storable = storableJson(event)
      const apart = await keepFilesApart(session, session.id, storable)
      if (apart !== storable) noteInlineFiles(conn)
      return { seq, event: apart }
    }),
  )
  const all = kept.map((e) => rows(e.seq, e.event))
  const refused = await prisma.sessionEvent.createMany({ data: all, skipDuplicates: true }).then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!refused) return
  // One at a time, to find which: a database that is down refuses them all, and the error goes on.
  for (const { seq, event } of kept) {
    const forms = storableForms(event)
    for (const [i, form] of forms.entries()) {
      const error = await prisma.sessionEvent
        .createMany({ data: [rows(seq, form)], skipDuplicates: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      if (!error) break
      if (i === forms.length - 1) throw error
      console.error(
        `thread ${session.id}: event ${seq} (${event.type}) refused, storing it ${i ? 'as missing' : 'cut short'}`,
        error,
      )
    }
  }
}

/**
 * Move lastSeq over the contiguous run of stored events, once what they open or
 * close (tickets, accounts) is done: should that fail, or the API stop halfway,
 * it is done again from the stored events, so a ticket the thread waits on is
 * never lost. Tried again here as well, for a runner that sends nothing more.
 */
async function advance(hub: WorkspaceHub, conn: RunnerConn, session: Session) {
  const stored = await prisma.sessionEvent.findMany({
    where: { sessionId: session.id, seq: { gt: session.lastSeq } },
    orderBy: { seq: 'asc' },
    select: { seq: true, data: true },
  })
  let lastSeq = session.lastSeq
  const fresh: SequencedEvent[] = []
  for (const row of stored) {
    if (row.seq !== lastSeq + 1) break
    lastSeq = row.seq
    fresh.push({
      sessionId: session.id,
      seq: row.seq,
      event: row.data as unknown as SequencedEvent['event'],
    })
  }
  if (lastSeq !== session.lastSeq) {
    if (!(await noteEvents(session, fresh))) return advanceLater(hub, conn, session.id)
    // A person's message reaching the teammate reopens its done thread (src/thread-done.ts), as
    // the message route does on sending it: one queued while the thread was being declared done
    // is not left unanswered behind it. Before the checkpoint moves, so that a failure is tried
    // again with these events rather than lost once they are acknowledged. Not a wake-up's nor a
    // child's report, which carry no member.
    if (fresh.some(fromPerson))
      try {
        await reopenThread(session, session.id)
      } catch (error) {
        console.warn(`thread ${session.id}: not reopened yet: ${String(error)}`)
        return advanceLater(hub, conn, session.id)
      }
    const status = fresh.reduce<SessionStatus>(
      (current, e) => statusAfter(current, e.event),
      session.status,
    )
    await prisma.session.update({ where: { id: session.id }, data: { lastSeq, status } })
    if (status === 'failed' && session.status !== 'failed') {
      const error = fresh.findLast((e) => e.event.type === 'error')?.event
      noteFailure('turn', error && 'message' in error ? error.message : 'failed', {
        workspaceId: session.workspaceId,
      })
    }
    hub.broadcast({ type: 'events', events: fresh }, session.id)
    // Its status changed, or its preview did: the sidebar marks a thread with one up.
    if (status !== session.status || fresh.some((e) => e.event.type === 'preview.changed'))
      hub.broadcast({ type: 'thread.updated', sessionId: session.id, status })
    // A preview that stopped for good: its public address stops working.
    notePreviewEvents(session.id, fresh)
    // A move waiting on the turn goes once it ends.
    if (status !== session.status && session.move)
      void movesOn(conn.computerId, session.id).catch(console.error)
    // Not awaited: a merge under way may call GitHub and prompt the author.
    void noteTurnsEnded(session, fresh).catch(console.error)
    // A turn that ended with the thread idle may have left mail without a reply or a word on it:
    // it is asked once what it did with it (src/mail/outcomes.ts). Not awaited.
    void noteMailLeft(
      session,
      status === 'idle' && fresh.some((e) => e.event.type === 'turn.completed'),
    ).catch(console.error)
    // Product analytics (src/analytics.ts): the turns these events end. Not awaited.
    trackTurns(session, fresh)
    // Not awaited, nor tried again: the tokens a turn spent never hold its thread back.
    void noteTokenUsage(session, fresh).catch((error) =>
      console.warn(`thread ${session.id}: token usage not kept: ${String(error)}`),
    )
    // A message in a thread put away for later brings it back (src/later.ts): a member's,
    // a wake-up's or a child's report, each a new turn. Not the end of a turn already under
    // way when it was put away. A child's do not, a schedule's quiet runs among them.
    if (!session.parentId && fresh.some((e) => e.event.type === 'message.user'))
      void bringBackFromLater(session, session.id).catch(console.error)
    // A child's report goes to its parent once its turn ends.
    if (session.parentId) void noteChildEvents(session, fresh).catch(console.error)
    // A dry run's event is done once its turn ends: the next one starts.
    if (session.playbookRunId) void noteDryRunEvents(session, fresh).catch(console.error)
  }
  hub.send(conn, { type: 'ack', sessionId: session.id, seq: lastSeq })
}

/** A person's message, queued or reaching the teammate: wake-ups and reports carry no member. */
const fromPerson = (e: SequencedEvent) =>
  (e.event.type === 'message.user' || e.event.type === 'message.queued') && !!e.event.memberId

/** The thread's events once more, after a while: what they open or close failed to be done. */
function advanceLater(hub: WorkspaceHub, conn: RunnerConn, sessionId: string) {
  if (conn.retries.has(sessionId)) return
  const timer = setTimeout(() => {
    conn.retries.delete(sessionId)
    conn.queue = conn.queue
      .then(async () => {
        const session = await prisma.session.findFirst({
          where: { id: sessionId, computerId: conn.computerId },
        })
        if (session) await advance(hub, conn, session)
      })
      .catch((error) => console.error(`thread ${sessionId}: could not try its events again`, error))
  }, NOTE_RETRY_MS)
  timer.unref?.()
  conn.retries.set(sessionId, timer)
}

/**
 * The runner's threads whose events have waited for minutes, as it says: their pages
 * say so instead of showing them at work, and the API logs it. A thread it no longer
 * lists got through.
 */
async function noteEventsWaiting(
  hub: WorkspaceHub,
  conn: RunnerConn,
  threads: { sessionId: string; since: string }[],
) {
  const listed = new Map(threads.map((t) => [t.sessionId, t.since]))
  const before = hub.waitingOn(conn.computerId)
  const fresh = [...listed].filter(([id, since]) => before.get(id) !== since)
  // Only its own threads: a thread that moved away is not this runner's to report.
  const own = fresh.length
    ? await prisma.session.findMany({
        where: { id: { in: fresh.map(([id]) => id) }, computerId: conn.computerId },
        select: { id: true },
      })
    : []
  const mine = new Map(fresh.filter(([id]) => own.some((s) => s.id === id)))
  for (const [id, since] of mine)
    console.error(`runner ${conn.runnerId}: thread ${id}'s events unacknowledged since ${since}`)
  // Those it still lists unchanged stay; those it no longer lists got through.
  const still = new Set([...listed.keys()].filter((id) => before.has(id) || mine.has(id)))
  const changed = hub.setEventsWaiting(conn.computerId, mine, still)
  await hub.broadcastEventsWaiting(changed)
}
