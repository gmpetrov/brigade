#!/usr/bin/env node
// brigade-runner: links this computer to a workspace and runs its threads.
//
//   brigade-runner link <code> [--api <url>] [--name <name>]
//   brigade-runner [start] [--concurrency <n>]
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { RunnerLinkResult, type AgentEvent, type ApiToRunner } from '@brigade/contracts'
import { CLOUD, HOME, loadConfig, paths, saveConfig, VERSION } from './config.js'
import { Accounts, machineLogins } from './accounts.js'
import { Connection } from './connection.js'
import { readThreadFile } from './files.js'
import { Library, LIBRARY_DIR } from './library.js'
import { BROWSER_START_PAGE, ensureBrowser } from './browsers.js'
import { desktopClipboard } from './desktop.js'
import { changedFilesSince, Terminals } from './terminals.js'
import { stripApiKeys } from './harness/index.js'
import { Outbox } from './outbox.js'
import { Threads } from './threads.js'
import { prefetch, sweep, type BackupName, type BundleStore } from './repos.js'
import { Updater } from './updater.js'

// Brigade sets no API key anywhere; harnesses use this computer's subscription logins.
stripApiKeys()

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: 'http://localhost:3001' },
    name: { type: 'string', default: hostname() },
    concurrency: { type: 'string', default: '4' },
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
  const outbox = new Outbox(paths.outbox)
  const library = new Library(config)
  void library.cleanTemp()
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
      onPending: (ticketId: string, reason?: string) =>
        emit({
          at: new Date().toISOString(),
          type: 'approval.requested',
          approvalId: ticketId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          ...(reason ? { reason } : {}),
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
  const threads = new Threads({
    concurrency: Number(values.concurrency),
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
    // So do credentials: released once a member mentioned them in the thread, or a person approves.
    requestCredential: (sessionId, teammateId, { toolCallId, toolName, input, ...request }) =>
      connection.requestCredential(
        { sessionId, teammateId, ...request },
        approvalHooks(sessionId, teammateId, { toolCallId, toolName, input }),
      ),
    handoff: (sessionId, fromTeammateId, teammateIds) =>
      connection.send({ type: 'thread.handoff', sessionId, fromTeammateId, teammateIds }),
    context: {
      libraryDir: LIBRARY_DIR,
      memoryFor: (teammateId) => library.memoryFor(teammateId),
      bundles,
    },
    callLibrary: (sessionId, teammateId, { operation }) =>
      connection.callLibrary({ sessionId, teammateId, operation }),
    memoryUpdate: (update) => connection.send(update),
  })
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
  const onCommand = async (message: ApiToRunner) => {
    switch (message.type) {
      case 'thread.prompt':
      case 'thread.approval':
      case 'thread.answer':
      case 'thread.interrupt':
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
      case 'thread.takeover':
        return threads.takeover(message.thread, message.memberId, message.interrupt)
      case 'thread.handback':
        return threads.handback(message.thread, message.memberId, message.note, (since) =>
          changedFilesSince(message.thread, since),
        )
      case 'terminal.open':
        return terminals
          .start(message.terminalId, message.thread, message.memberId, message.cols, message.rows)
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
      case 'repos.changed':
        return prefetch(message.repository, message.fetch)
      case 'library.changed':
        return library.sync()
      case 'thread.file.read':
        return readThreadFile(message).then(
          (result) => connection.send(result),
          (error) =>
            connection.send({
              type: 'thread.file.result',
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
    }
  }

  // On a member's own machine, report which harnesses are already signed in there; on a
  // cloud computer, which root setup it has. Each connect also refreshes the library.
  const hello = async () => {
    void library.sync()
    if (!CLOUD) return { machineLogins: await machineLogins() }
    const setup = await readFile('/var/lib/brigade/setup', 'utf8').catch(() => '')
    return setup.trim() ? { setup: setup.trim() } : {}
  }
  // Updates wait for a quiet moment: no turn running or queued, no terminal, no sign-in.
  const updater = new Updater({
    apiUrl: config.apiUrl,
    idle: () => !threads.busy && terminals.count === 0 && !accounts.busy,
    stop: async () => {
      // No new commands once disconnected; a turn that slipped in finishes first.
      connection.close()
      terminals.closeAll()
      await threads.settle()
      await threads.parkAll()
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

  const shutdown = async () => {
    console.log('stopping: saving thread state')
    terminals.closeAll()
    connection.close()
    await threads.parkAll()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
