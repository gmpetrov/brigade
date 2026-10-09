#!/usr/bin/env node
// brigade-runner: links this computer to a workspace and runs its threads.
//
//   brigade-runner link <code> [--api <url>] [--name <name>]
//   brigade-runner [start] [--concurrency <n>]
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { RunnerLinkResult, type AgentEvent, type ApiToRunner } from '@brigade/contracts'
import { CLOUD, HOME, loadConfig, paths, saveConfig, VERSION } from './config.js'
import { Accounts, machineLogins } from './accounts.js'
import { Connection } from './connection.js'
import { changedFilesSince, Terminals } from './terminals.js'
import { stripApiKeys } from './harness/index.js'
import { Outbox } from './outbox.js'
import { Threads } from './threads.js'

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
  let connection: Connection
  const threads = new Threads({
    concurrency: Number(values.concurrency),
    emit: (sessionId, event) => connection.sendEvent(outbox.push(sessionId, event)),
    // Connector calls go to the API. A write waiting for a person shows as an approval in the thread.
    callConnector: (sessionId, call) => {
      const emit = (event: AgentEvent) => connection.sendEvent(outbox.push(sessionId, event))
      return connection.callConnector(
        {
          sessionId,
          connectionId: call.connectionId,
          operation: call.operation,
          input: call.input,
        },
        {
          onPending: (ticketId) =>
            emit({
              at: new Date().toISOString(),
              type: 'approval.requested',
              approvalId: ticketId,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            }),
          onDecision: (d) =>
            emit({
              at: new Date().toISOString(),
              type: 'approval.resolved',
              approvalId: d.ticketId,
              approved: d.approved,
              memberId: d.memberId,
            }),
        },
      )
    },
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
    }
  }

  // On a member's own machine, report which harnesses are already signed in there.
  const hello = async () => (CLOUD ? {} : { machineLogins: await machineLogins() })
  connection = new Connection(config, outbox, (message) => void onCommand(message), hello)
  connection.start()

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
