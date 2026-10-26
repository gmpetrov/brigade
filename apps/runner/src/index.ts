#!/usr/bin/env node
// brigade-runner: links this computer to a workspace and runs its threads.
//
//   brigade-runner link <code> [--api <url>] [--name <name>]
//   brigade-runner [start] [--concurrency <n>]
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  NODE_VERSION,
  nodeAtLeast,
  RunnerLinkResult,
  type AgentEvent,
  type ApiToRunner,
  type ThreadSpec,
} from '@brigade/contracts'
import {
  ALREADY_RUNNING_EXIT_CODE,
  claimRunner,
  CLOUD,
  HOME,
  loadConfig,
  machineId,
  paths,
  saveConfig,
  VERSION,
} from './config.js'
import { Accounts, machineLogins } from './accounts.js'
import { Attachments } from './attachments.js'
import { Connection } from './connection.js'
import { describeProject } from './describe.js'
import { codeFiles } from './code-files.js'
import { findSource, readThreadFile, writeThreadFile } from './files.js'
import { Folders, ThreadGone, type FolderName } from './folders.js'
import { Library } from './library.js'
import {
  BROWSER_START_PAGE,
  browserCandidates,
  ensureBrowser,
  focusThreadTab,
  stopIdleBrowsers,
} from './browsers.js'
import { desktopClipboard } from './desktop.js'
import { changedFilesSince, Terminals } from './terminals.js'
import { stripApiKeys, usePersonPath, type Transcript } from './harness/index.js'
import { Outbox } from './outbox.js'
import { imageStore } from './reply-images.js'
import { MemoryGuard } from './memory-guard.js'
import { runnerCgroups } from './preview-cgroup.js'
import { Previews } from './previews.js'
import { processGroups } from './process-groups.js'
import { teammateUser } from './teammates.js'
import { Threads, threadFolder } from './threads.js'
import { prefetch, sweep, type BackupName, type BundleStore } from './repos.js'
import { Updater } from './updater.js'
import { sendUsageRunsTo } from './usage.js'
import { noteHandOver, takeHandOver } from './hand-over.js'

/** While an update hands its turns over, how long the calls under way get to finish on the connection. */
const CALLS_GRACE_MS = 8_000

// Brigade sets no API key anywhere; harnesses use this computer's subscription logins.
stripApiKeys()
if (!CLOUD) usePersonPath()

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: 'http://localhost:3001' },
    name: { type: 'string', default: hostname() },
    concurrency: { type: 'string', default: '8' },
    version: { type: 'boolean' },
    /** Set on a workspace cloud computer: no member's own logins live there. */
    cloud: { type: 'boolean' },
  },
})

if (values.version) {
  console.log(VERSION)
  process.exit(0)
}

const [command = 'start', ...rest] = positionals

if (command === 'link') await link(rest[0])
else if (command === 'start') await start()
else {
  console.error(`Unknown command "${command}". Use "link <code>" or "start".`)
  process.exit(1)
}

async function link(code: string | undefined) {
  // Linked before to this API: the API replaces that computer rather than adding a second one.
  const previous = await loadConfig()
  if (!code) {
    console.error(
      'Usage: brigade-runner link <code> [--api <url>]  (get a code from the dashboard)',
    )
    process.exit(1)
  }
  const response = await fetch(new URL('/runner/link', values.api), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      name: values.name,
      platform: `${process.platform}-${process.arch}`,
      version: VERSION,
      ...(CLOUD ? {} : { machineId: machineId() }),
      ...(previous && previous.apiUrl === values.api ? { computerId: previous.computerId } : {}),
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error(`Could not link: ${(body as { error?: string }).error ?? response.statusText}`)
    process.exit(1)
  }
  const result = RunnerLinkResult.parse(body)
  await saveConfig({
    apiUrl: values.api,
    token: result.token,
    computerId: result.computerId,
    workspaceName: result.workspaceName,
  })
  console.log(
    `Linked "${values.name}" to workspace "${result.workspaceName}". Start it with: brigade-runner start`,
  )
}

async function start() {
  const config = await loadConfig()
  if (!config) {
    console.error(
      `Not linked yet. Run: brigade-runner link <code> --api <url>   (state lives in ${HOME})`,
    )
    process.exit(1)
  }
  const other = await claimRunner()
  if (other) {
    console.error(`A runner is already running from ${HOME} (pid ${other}). Stop it first.`)
    process.exit(ALREADY_RUNNING_EXIT_CODE)
  }
  // The installer moves an installed runner onto it at its next update; one run from source does not.
  if (!nodeAtLeast(process.version))
    console.warn(
      `running on Node.js ${process.version}, older than ${NODE_VERSION}: it misses security fixes`,
    )
  // Before any preview starts again on a port one of them may still hold. The harnesses of
  // turns an update handed over stay, for their threads to take up.
  await processGroups.reap(takeHandOver()).then(
    (left) => left && console.log(`stopped what the runner before this one left running: ${left}`),
    (error: unknown) =>
      console.warn(`could not look for what the runner before left: ${String(error)}`),
  )
  const outbox = new Outbox(paths.outbox)
  const library = new Library(config)
  void library.cleanTemp()
  const attachments = new Attachments(config)
  void attachments.cleanCache()
  // Git backups GitHub would not take, kept in the API's bucket.
  const bundleUrl = (b: BackupName) =>
    new URL(
      `/runner/backups/${[...b.repository.split('/'), b.sessionId, b.teammateId, b.folder]
        .map(encodeURIComponent)
        .join('/')}`,
      config.apiUrl,
    )
  const bundles: BundleStore = {
    put: async (backup, bundle) => {
      const response = await fetch(bundleUrl(backup), {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/x-git-bundle',
        },
        body: new Uint8Array(bundle),
      })
      if (!response.ok) throw new Error(`the API refused the backup (${response.status})`)
    },
    get: async (backup) => {
      const response = await fetch(bundleUrl(backup), {
        headers: { authorization: `Bearer ${config.token}` },
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`the API refused the backup (${response.status})`)
      return Buffer.from(await response.arrayBuffer())
    },
  }
  // Thread folders archived to free disk, in the API's bucket until their thread comes back.
  // The bytes go straight to and from R2 through signed URLs.
  const folderRequest = async (f: FolderName, path: string, init: RequestInit = {}) => {
    const url = new URL(
      `/runner/folders/${encodeURIComponent(f.sessionId)}/${encodeURIComponent(f.teammateId)}${path}`,
      config.apiUrl,
    )
    return fetch(url, {
      ...init,
      // A signed URL it redirects to is followed without the runner's token.
      redirect: 'manual',
      headers: { authorization: `Bearer ${config.token}`, ...init.headers },
    })
  }
  const refused = (what: string, response: Response) =>
    new Error(`the ${what} refused the folder archive (${response.status})`)
  const sizeBody = (size: number): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size }),
  })
  const fileBody = (file: string) =>
    ({
      body: Readable.toWeb(createReadStream(file)) as ReadableStream,
      duplex: 'half',
    }) as RequestInit
  const folders = new Folders({
    archives: {
      put: async (f, file, size) => {
        const ticket = await folderRequest(f, '/upload', sizeBody(size))
        if (ticket.status === 410) throw new ThreadGone(`thread ${f.sessionId} was deleted`)
        if (!ticket.ok) throw refused('API', ticket)
        const { url, headers } = (await ticket.json()) as {
          url: string | null
          headers?: Record<string, string>
        }
        const length = { 'content-length': String(size) }
        const upload = url
          ? await fetch(url, {
              method: 'PUT',
              ...fileBody(file),
              headers: { ...headers, ...length },
            })
          : await folderRequest(f, '', {
              method: 'PUT',
              ...fileBody(file),
              headers: { 'content-type': 'application/gzip', ...length },
            })
        if (!upload.ok) throw refused(url ? 'bucket' : 'API', upload)
        // The API checks the bucket has all of it before the folder is removed.
        const done = await folderRequest(f, '/done', sizeBody(size))
        if (!done.ok) throw refused('API', done)
      },
      get: async (f, file) => {
        let response = await folderRequest(f, '')
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location)
          response = await fetch(location)
        // 410: the thread was deleted, and its archive with it.
        if (response.status === 404 || response.status === 410) return false
        if (!response.ok || !response.body) throw refused('API', response)
        await pipeline(
          Readable.fromWeb(response.body as NodeReadableStream),
          createWriteStream(file, { mode: 0o600 }),
        )
        return true
      },
      delete: async (f) => {
        const response = await folderRequest(f, '', { method: 'DELETE' })
        if (!response.ok) throw refused('API', response)
      },
      gone: async (f) => {
        // The same request as get: it answers 410 before looking for an archive.
        const response = await folderRequest(f, '')
        await response.body?.cancel()
        return response.status === 410
      },
    },
    inUse: (sessionId): boolean => threads.inUse(sessionId) || previews.has(sessionId),
    quiet: (name) => previews.archive(name.sessionId),
    stateFile: join(paths.state, 'folders.json'),
    tempDir: join(paths.state, 'folder-archives'),
    reserveFile: join(paths.state, 'disk-reserve'),
    // Still full: a ticket asks someone to act, closed once there is room (DISK_PROTOCOL).
    reportDisk: (disk) => connection.send({ type: 'disk', ...disk }),
  })
  // Before a thread's folder is used outside a turn: put back when it was archived.
  const folderReady = (sessionId: string, teammateIds: string[]) =>
    Promise.all(teammateIds.map((teammateId) => folders.ready({ sessionId, teammateId })))
  let connection: Connection
  // A call waiting for a person shows as an approval in its thread, then as the decision.
  const approvalHooks = (
    sessionId: string,
    teammateId: string,
    call: { toolCallId: string; toolName: string; input: unknown },
  ) => {
    const emit = (event: AgentEvent) =>
      connection.sendEvent(outbox.push(sessionId, { ...event, teammateId }))
    return {
      onPending: (ticketId: string, reason?: string, always?: boolean) =>
        emit({
          at: new Date().toISOString(),
          type: 'approval.requested',
          approvalId: ticketId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          ...(reason ? { reason } : {}),
          ...(always ? { always: true } : {}),
        }),
      onDecision: (d: { ticketId: string; approved: boolean; memberId: string }) =>
        emit({
          at: new Date().toISOString(),
          type: 'approval.resolved',
          approvalId: d.ticketId,
          approved: d.approved,
          memberId: d.memberId,
        }),
    }
  }
  // Apps teammates run for people to try. On a cloud computer the API has their ports hosted.
  const previews = new Previews({
    emit: (sessionId, event) => connection.sendEvent(outbox.push(sessionId, event)),
    expose: CLOUD ? (sessionId, ports) => connection.exposePreview(sessionId, ports) : null,
    viewUrl: CLOUD ? (sessionId, port) => connection.previewUrl(sessionId, port) : null,
    recipes: (sessionId, teammateId, operation) =>
      connection.callPreview({ sessionId, teammateId, operation }),
    seat: (sessionId, teammateId) => ({
      sessionId,
      teammateId,
      ...threadFolder(teammateId, sessionId),
    }),
    stateFile: join(paths.state, 'previews.json'),
    busy: (sessionId) => threads.inUse(sessionId),
  })
  const threads = new Threads({
    concurrency: Number(values.concurrency),
    previews,
    folders,
    // The images a reply shows, straight to the API's bucket through a signed URL.
    storeImage: imageStore(config),
    emit: (sessionId, event) => connection.sendEvent(outbox.push(sessionId, event)),
    // Connector calls go to the API. A write waiting for a person shows as an approval in the thread.
    callConnector: (sessionId, teammateId, call) =>
      connection.callConnector(
        {
          sessionId,
          teammateId,
          connectionId: call.connectionId,
          operation: call.operation,
          input: call.input,
        },
        approvalHooks(sessionId, teammateId, call),
      ),
    // So do credentials: released once a member mentioned them, a person approves, or a grant allows it.
    requestCredential: (sessionId, teammateId, { toolCallId, toolName, input, ...request }) =>
      connection.requestCredential(
        { sessionId, teammateId, ...request },
        approvalHooks(sessionId, teammateId, { toolCallId, toolName, input }),
      ),
    attachments,
    handoff: (sessionId, fromTeammateId, teammateIds) =>
      connection.send({ type: 'thread.handoff', sessionId, fromTeammateId, teammateIds }),
    context: {
      libraryDir: (teammateId) => library.view(teammateId),
      memoryFor: (teammateId) => library.memoryFor(teammateId),
      bundles,
      uploadFile: (input) => attachments.upload(input),
      skillFile: (hash) => attachments.skillFile(hash),
      conversation: async (sessionId, teammateId) => {
        const response = await folderRequest({ sessionId, teammateId }, '/conversation')
        if (!response.ok) throw new Error(`the API refused the conversation (${response.status})`)
        return ((await response.json()) as { transcript: Transcript }).transcript
      },
    },
    callLibrary: (sessionId, teammateId, { operation }) =>
      connection.callLibrary({ sessionId, teammateId, operation }),
    callTask: (sessionId, teammateId, { operation }) =>
      connection.callTask({ sessionId, teammateId, operation }),
    callSchedule: (sessionId, teammateId, { operation, toolCallId, toolName, input }) =>
      connection.callSchedule(
        { sessionId, teammateId, operation },
        approvalHooks(sessionId, teammateId, { toolCallId, toolName, input }),
      ),
    memoryUpdate: (update) => connection.send(update),
    memoryTidy: (tidy) => connection.send(tidy),
    title: (update) => connection.send(update),
  })
  sendUsageRunsTo((run) => connection.send(run))
  // A teammate's browser that nobody uses stops, unless a person has control of one of its threads.
  const controlled = (user: string) =>
    [...threads.controlledTeammates()].some((id) => teammateUser(id) === user)
  if (CLOUD) stopIdleBrowsers(controlled)
  // On a cloud computer, the computer running out of memory as a whole: an idle browser, a preview
  // or a turn is stopped, with the reason, before it stops answering at all.
  if (CLOUD && process.env.BRIGADE_MEMORY_GUARD !== '0') {
    new MemoryGuard({
      candidates: async () => [
        ...(await previews.memoryCandidates()),
        ...(await browserCandidates(controlled)),
        ...(await Promise.all(
          ((await runnerCgroups())?.turns ?? []).map(async (turn) => {
            const memory = await turn.cgroup.resident()
            return {
              kind: 'turn' as const,
              memory,
              stop: async (why: string) => {
                await turn.cgroup.kill()
                if (turn.thread)
                  connection.sendEvent(
                    outbox.push(turn.thread, {
                      at: new Date().toISOString(),
                      type: 'raw',
                      source: 'runner',
                      value: `The teammate's session in this thread was stopped to give the computer memory back: ${why}, and it held the most (${(memory / 1024 ** 3).toFixed(1)} GB). Send a message to go on.`,
                    }),
                  )
              },
            }
          }),
        )),
      ],
    }).start()
  }
  const accounts = new Accounts({
    prompt: (loginId, prompt) =>
      connection.send({ type: 'account.login.prompt', loginId, ...prompt }),
    done: (loginId, done) => connection.send({ type: 'account.login.done', loginId, ...done }),
  })
  const loginFailed = (loginId: string, error: unknown) =>
    connection.send({ type: 'account.login.done', loginId, ok: false, error: String(error) })

  const terminals = new Terminals({
    output: (terminalId, data) => connection.send({ type: 'terminal.output', terminalId, data }),
    exit: (terminalId, code) => connection.send({ type: 'terminal.exit', terminalId, code }),
    event: (sessionId, event) => connection.sendEvent(outbox.push(sessionId, event)),
  })
  // A thread that moved here: its events go on after the API's, and what this runner kept of it from before goes.
  const arrive = (spec: ThreadSpec) => {
    if (!spec.moved || !outbox.arrive(spec.sessionId, spec.moved.at, spec.moved.seq)) return
    threads.forget(spec.sessionId)
    // The thread says where it went, numbered after the API's last event.
    connection.sendEvent(
      outbox.push(spec.sessionId, {
        at: new Date().toISOString(),
        type: 'raw',
        source: 'runner',
        value: `Moved from ${spec.moved.from} to ${spec.moved.to ?? 'this computer'}.`,
      }),
    )
  }
  const arriveFolder = (spec: ThreadSpec) =>
    spec.moved
      ? folders.arrive({ sessionId: spec.sessionId, teammateId: spec.teammate.id }, spec.moved)
      : Promise.resolve()
  const onCommand = async (message: ApiToRunner) => {
    if ('thread' in message) arrive(message.thread)
    switch (message.type) {
      case 'welcome': {
        // Turns and messages a restart cut off go on, in order; what the API could not say how to continue is closed.
        const last = (sessionId: string) => outbox.lastUnacknowledged(sessionId)
        const unacknowledged = (sessionId: string) => outbox.unacknowledgedFor(sessionId)
        for (const spec of [
          ...(message.resume ?? []),
          ...(message.requeue ?? []).map((p) => p.thread),
        ])
          arrive(spec)
        threads.resumeLost(message.resume ?? [], message.runningThreads ?? [], last)
        // The previews an update stopped (once, after it).
        void previews.startAgain()
        threads.requeueLost(message.requeue ?? [], unacknowledged)
        const requeued = new Set(
          (message.requeue ?? []).map((p) => `${p.thread.sessionId}:${p.messageId}`),
        )
        threads.dropLost(
          (message.queuedMessages ?? []).filter(
            (q) => !requeued.has(`${q.sessionId}:${q.messageId}`),
          ),
          unacknowledged,
        )
        return threads.closeLost(message.runningThreads ?? [], last)
      }
      case 'thread.prompt':
      case 'thread.approval':
      case 'thread.answer':
      case 'thread.ticket':
      case 'thread.interrupt':
      case 'thread.queued':
      case 'thread.retry':
        try {
          threads.handle(message)
        } catch (error) {
          connection.send({
            type: 'command.failed',
            commandId: message.commandId,
            error: String(error),
          })
        }
        return
      case 'thread.release':
        return threads
          .handOver(message.sessionId, message.teammateIds)
          .then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error: String(error) }),
          )
          .then(async (result) => {
            // Its last events reach the API before it moves: none are numbered twice.
            for (let i = 0; i < 60 && !outbox.settled(message.sessionId); i++) await sleep(500)
            connection.send({
              type: 'thread.release.result',
              requestId: message.requestId,
              ...result,
            })
          })
      case 'thread.takeover':
        return arriveFolder(message.thread)
          .then(() => folderReady(message.thread.sessionId, [message.thread.teammate.id]))
          .catch((error) =>
            console.warn(`could not put the thread's folder back: ${String(error)}`),
          )
          .then(() => threads.takeover(message.thread, message.memberId, message.interrupt))
      case 'thread.handback':
        return threads.handback(message.thread, message.memberId, message.note, (since) =>
          changedFilesSince(message.thread, since),
        )
      case 'terminal.open':
        return arriveFolder(message.thread)
          .then(() => folderReady(message.thread.sessionId, [message.thread.teammate.id]))
          .then(() =>
            terminals.start(
              message.terminalId,
              message.thread,
              message.memberId,
              message.cols,
              message.rows,
            ),
          )
          .catch((error) => {
            connection.send({
              type: 'terminal.output',
              terminalId: message.terminalId,
              data: `\r\n${String(error)}\r\n`,
            })
            connection.send({ type: 'terminal.exit', terminalId: message.terminalId, code: null })
          })
      case 'terminal.input':
        return terminals.input(message.terminalId, message.data)
      case 'terminal.close':
        return terminals.close(message.terminalId)
      case 'account.login.start':
        return accounts
          .start(message.loginId, message.account)
          .catch((error) => loginFailed(message.loginId, error))
      case 'account.login.code':
        try {
          accounts.submit(message.loginId, message.code)
        } catch (error) {
          loginFailed(message.loginId, error)
        }
        return
      case 'account.login.cancel':
        return accounts.cancel(message.loginId)
      case 'account.remove':
        return accounts.remove(message.account)
      case 'desktop.clipboard':
        if (!CLOUD)
          return connection.send({
            type: 'desktop.clipboard.result',
            requestId: message.requestId,
            error: 'Not a cloud computer',
          })
        return desktopClipboard(message.text).then(
          (text) =>
            connection.send({
              type: 'desktop.clipboard.result',
              requestId: message.requestId,
              text,
            }),
          (error) =>
            connection.send({
              type: 'desktop.clipboard.result',
              requestId: message.requestId,
              error: String(error),
            }),
        )
      case 'preview.control':
        if (message.action === 'touch') return previews.touch(message.sessionId)
        if (message.action === 'stop')
          return void previews.stop(message.sessionId, message.reason ?? 'Stopped by a person')
        return previews
          .restart(message.sessionId)
          .catch((error) => console.warn(`preview restart failed: ${String(error)}`))
      case 'preview.start':
        return folderReady(message.sessionId, message.teammateIds)
          .then(() => previews.startFor(message.sessionId, message.teammateIds, message.repository))
          .then(
            (result) =>
              connection.send({
                type: 'preview.start.result',
                requestId: message.requestId,
                ok: true,
                result,
              }),
            (error: unknown) =>
              connection.send({
                type: 'preview.start.result',
                requestId: message.requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          )
      case 'preview.logs':
        try {
          return connection.send({
            type: 'preview.logs.result',
            requestId: message.requestId,
            ok: true,
            text: previews.logs(message.sessionId),
          })
        } catch (error) {
          return connection.send({
            type: 'preview.logs.result',
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      case 'project.describe':
        return describeProject(message).then((result) => connection.send(result))
      case 'repos.changed':
        return prefetch(message.repository, message.fetch)
      case 'library.changed':
        return library.sync()
      case 'thread.note':
        return threads.noteFromOutside(message.sessionId, message.text)
      case 'thread.deleted':
        await previews.stop(message.sessionId, 'The thread was deleted')
        threads.forget(message.sessionId)
        return folders
          .removeThread(message.sessionId)
          .catch((error) =>
            console.warn(`could not remove the folders of a deleted thread: ${String(error)}`),
          )
      case 'thread.file.read':
        return folderReady(message.sessionId, message.teammateIds)
          .then(() => readThreadFile(message))
          .then(
            (result) => connection.send(result),
            (error) =>
              connection.send({
                type: 'thread.file.result',
                requestId: message.requestId,
                ok: false,
                error: String(error),
              }),
          )
      case 'thread.file.write':
        return folderReady(message.sessionId, [message.teammateId])
          .then(() => writeThreadFile(message))
          .then(
            (result) => connection.send(result),
            (error) =>
              connection.send({
                type: 'thread.file.written',
                requestId: message.requestId,
                ok: false,
                error: String(error),
              }),
          )
      case 'thread.code':
        return folderReady(message.sessionId, [message.teammateId])
          .then(() => codeFiles(message))
          .then(
            (result) => connection.send(result),
            (error) =>
              connection.send({
                type: 'thread.code.result',
                requestId: message.requestId,
                ok: false,
                error: String(error),
              }),
          )
      case 'thread.source.find':
        return folderReady(message.sessionId, [message.teammateId])
          .then(() => findSource(message))
          .then(
            (result) => connection.send(result),
            (error) =>
              connection.send({
                type: 'thread.source.result',
                requestId: message.requestId,
                ok: false,
                error: String(error),
              }),
          )
      case 'browser.open':
        if (!CLOUD) return
        return ensureBrowser(
          { id: message.teammateId, name: message.teammateName },
          message.url ?? BROWSER_START_PAGE,
        ).then(
          () => undefined,
          (error) =>
            connection.send({
              type: 'command.failed',
              commandId: message.commandId,
              error: String(error),
            }),
        )
      case 'browser.focus':
        if (!CLOUD) return
        return focusThreadTab(message.teammateId, message.sessionId).catch((error) =>
          console.warn(`could not bring ${message.sessionId}'s tab to the front: ${error}`),
        )
    }
  }

  // On a member's own machine, report which harnesses are already signed in there; on a
  // cloud computer, which root setup it has. Each connect also refreshes the library.
  const hello = async () => {
    void library.sync()
    if (!CLOUD) return { machineLogins: await machineLogins(), machineId: machineId() }
    const setup = await readFile('/var/lib/brigade/setup', 'utf8').catch(() => '')
    return setup.trim() ? { setup: setup.trim() } : {}
  }
  // An update waits only for what a restart would cut short and cannot hand over: a terminal,
  // a sign-in. The turns running then go on in their harnesses, which the new runner takes up
  // (hand-over.ts); previews start again there.
  const updater = new Updater({
    apiUrl: config.apiUrl,
    quiet: () => terminals.count === 0 && !accounts.busy,
    handOver: async () => {
      // From now on the API holds this computer's commands for the new runner.
      connection.send({ type: 'runner.restarting' })
      // The calls under way finish on this connection; past a while, closing it ends them.
      const closing = setTimeout(() => connection.close(), CALLS_GRACE_MS)
      noteHandOver(await threads.handOverTurns())
      clearTimeout(closing)
      terminals.closeAll()
      await previews.stopForUpdate()
      connection.close()
    },
  })
  connection = new Connection(
    config,
    outbox,
    (message) => void onCommand(message),
    hello,
    (bundle, required) => updater.offer(bundle, required),
  )
  connection.start()

  // Free disk now and then: checkouts of quiet threads that hold nothing GitHub lacks.
  const sweepRepos = () =>
    void sweep((sessionId) => threads.inUse(sessionId)).catch((error) =>
      console.warn(`repository sweep failed: ${String(error)}`),
    )
  setTimeout(sweepRepos, 10 * 60_000).unref()
  setInterval(sweepRepos, 6 * 60 * 60_000).unref()
  // On a cloud computer, archive the folders of the threads quiet longest when the disk fills up.
  folders.start()

  const shutdown = async () => {
    console.log('stopping: saving thread state')
    terminals.closeAll()
    // Reported before the connection closes; the outbox keeps it otherwise.
    await previews.stopAll('The computer stopped')
    connection.close()
    await threads.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
