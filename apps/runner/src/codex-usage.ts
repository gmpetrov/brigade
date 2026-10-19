// A Codex account's subscription limits. Claude Code reports its own during each
// turn; Codex's harness reports none, so after a Codex turn the runner asks
// Codex itself, as its /status does: a short `codex app-server` on the account's
// login, asked `account/rateLimits/read`. It calls no model and spends no usage.
import { spawn } from 'node:child_process'
import type { AccountRef, AgentEvent } from '@brigade/contracts'
import { accountEnv } from './accounts.js'
import { harnessEnv } from './harness/env.js'

export type Limits = NonNullable<Extract<AgentEvent, { type: 'usage.updated' }>['limits']>

/** Longest a read may take; the process is stopped after it. */
const READ_MS = 20_000
/** One read per account at most this often: turns ending together share it. */
const EVERY_MS = 60_000

type Window = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }

/** Codex's windows under the names Claude's use (five_hour, seven_day), else by their length. */
function windowName(minutes: unknown, fallback: string) {
  if (typeof minutes !== 'number' || minutes <= 0) return fallback
  if (minutes === 300) return 'five_hour'
  if (minutes === 10_080) return 'seven_day'
  if (minutes % 1440 === 0) return `${minutes / 1440}_day`
  if (minutes % 60 === 0) return `${minutes / 60}_hour`
  return `${minutes}_min`
}

/** The limits in a reply to `account/rateLimits/read`; none when it has none. */
export function codexLimits(reply: unknown): Limits {
  const snapshot = (reply as { rateLimits?: { primary?: Window; secondary?: Window } } | null)
    ?.rateLimits
  const windows: [Window | undefined, string][] = [
    [snapshot?.primary, 'five_hour'],
    [snapshot?.secondary, 'seven_day'],
  ]
  return windows.flatMap(([w, fallback]) =>
    w && typeof w.usedPercent === 'number'
      ? [
          {
            window: windowName(w.windowDurationMins, fallback),
            utilization: Math.min(1, Math.max(0, w.usedPercent / 100)),
            resetsAt:
              typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
          },
        ]
      : [],
  )
}

/** Ask a `codex app-server` on the account's login for its limits. Rejects when it cannot. */
function ask(account: AccountRef): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], {
      env: harnessEnv(accountEnv(account)),
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let settled = false
    const done = (error: Error | null, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => done(new Error('Codex did not answer in time')), READ_MS)
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        let message: { id?: unknown; result?: unknown; error?: { message?: string } }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          if (message.error) return done(new Error(message.error.message ?? 'initialize failed'))
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (message.id === 2) {
          if (message.error) return done(new Error(message.error.message ?? 'read failed'))
          return done(null, message.result)
        }
      }
    })
    child.stdin.on('error', () => {})
    child.on('error', (error) => done(error))
    child.on('close', () => done(new Error('Codex stopped before it answered')))
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'brigade', version: '1' } } })
  })
}

const reads = new Map<string, Promise<Limits | null>>()
const readAt = new Map<string, number>()

/**
 * The account's limits now, or null: read too recently, or Codex could not say
 * (signed out, offline). Never rejects, and never holds up a turn: call it once the turn is over.
 */
export function readCodexLimits(account: AccountRef): Promise<Limits | null> {
  if (account.provider !== 'codex') return Promise.resolve(null)
  const key = `${account.source}:${account.id}`
  const running = reads.get(key)
  if (running) return running.then(() => null)
  if (Date.now() - (readAt.get(key) ?? 0) < EVERY_MS) return Promise.resolve(null)
  readAt.set(key, Date.now())
  const read = ask(account)
    .then(codexLimits, (error: unknown) => {
      console.warn(
        `could not read the limits of Codex account ${account.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    })
    .finally(() => reads.delete(key))
  reads.set(key, read)
  return read
}
