// Each teammate's browser on a workspace cloud computer: one Chrome per
// teammate, as its Linux user, with its own profile in its home. Its sign-ins
// persist there for all of the teammate's threads. The harness drives it
// through Playwright's MCP server; a person uses the same windows on the
// desktop during takeover.
//
// A Chrome holds half a gigabyte or more even with nothing open, so it runs
// only while it is used: it starts at a turn's first browser tool call (the
// relay waits for it), or when a person opens it, and stops once no turn or
// person used it for a while. Its sign-ins stay in its profile meanwhile. It
// runs in a cgroup of its own (preview-cgroup.ts), where the memory guard sees
// what it holds and stops it before a turn.
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromeLog, chromeLogErrors } from './chrome-log.js'
import type { Candidate } from './memory-guard.js'
import { runnerCgroups } from './preview-cgroup.js'
import { teammateHome, teammateUser } from './teammates.js'

const run = promisify(execFile)
const HELPER = '/usr/local/sbin/brigade-teammate'
const PORT_BASE = 20_000

/** A browser no turn or person used for this long is stopped. */
const IDLE_MS = Number(process.env.BRIGADE_BROWSER_IDLE_MS) || 15 * 60_000

const uids = new Map<string, number>()

/** The debugging port of a teammate's browser, from its uid. The helper lets only that uid connect. */
async function portOf(user: string) {
  let uid = uids.get(user)
  if (uid === undefined) {
    const { stdout } = await run('id', ['-u', user], { cwd: '/' })
    uid = Number(stdout.trim())
    uids.set(user, uid)
  }
  return PORT_BASE + uid
}

/** The debugging port a teammate's browser has, running or not. */
export const browserPort = (teammateId: string) => portOf(teammateUser(teammateId))

/** When each teammate's browser was last used, by Linux user. */
const lastUsed = new Map<string, number>()

/** The teammate's browser is in use now: it is not stopped for a while. */
export function touchBrowser(teammateId: string, now = Date.now()) {
  lastUsed.set(teammateUser(teammateId), now)
}

/** A tool that drives the browser (Playwright MCP's), whatever the harness prefixes it with. */
export const isBrowserTool = (toolName: string) => /(^|[^a-z])browser_[a-z_]+$/.test(toolName)

/** Whether something listens on 127.0.0.1:port, read from /proc (connecting is firewalled). */
async function listening(port: number) {
  return listeningIn(await readFile('/proc/net/tcp', 'utf8').catch(() => ''), port)
}

function listeningIn(table: string, port: number) {
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
  return table.split('\n').some((line) => {
    const cols = line.trim().split(/\s+/)
    return cols[1] === local && cols[3] === '0A' // LISTEN
  })
}

/**
 * Start the teammate's browser if it is not running, optionally opening a
 * window at `url`. Returns its debugging port.
 */
/** What a browser waits for before it starts (a computer putting the old one's profiles back). */
let beforeStart: () => Promise<void> = () => Promise.resolve()
export const startBrowsersAfter = (wait: () => Promise<void>) => {
  beforeStart = wait
}

export async function ensureBrowser(teammate: { id: string; name: string }, url?: string) {
  await beforeStart()
  const user = teammateUser(teammate.id)
  const port = await portOf(user)
  touchBrowser(teammate.id)
  // Being stopped: started again once it is gone, not killed with what is left of it.
  await stopping.get(user)
  // The window title tells people on the desktop whose browser this is.
  const title = `${teammate.name.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) || 'Teammate'} browser`
  if (url) await helperBrowser(user, [user, String(port), title, url])
  else if (!(await listening(port))) {
    // Several threads may ask at once: one start, or the others would each open a window.
    // The helper returns before Chrome listens: the start lasts until it does.
    let start = starting.get(user)
    if (!start) {
      start = helperBrowser(user, [user, String(port), title])
        .then(() => untilListening(user, port))
        .finally(() => starting.delete(user))
      starting.set(user, start)
    }
    await start
  }
  await untilListening(user, port)
  return port
}

/** Once the browser listens on its port; an error with Chrome's reason when it does not. */
async function untilListening(user: string, port: number) {
  for (let i = 0; i < 100 && !(await listening(port)); i++)
    await new Promise((r) => setTimeout(r, 200))
  if (!(await listening(port))) {
    const why = await chromeErrors(user)
    throw new Error(`The browser of ${user} did not start${why ? `: ${why}` : ''}`)
  }
}

const starting = new Map<string, Promise<void>>()

/**
 * The helper's `browser`, in the browser's cgroup where the runner has them:
 * a shell that waits on fd 3 until it is in there, then becomes sudo, so the
 * Chrome it starts is in there from the start.
 */
async function helperBrowser(user: string, args: string[]) {
  const cgroup = await runnerCgroups()
    .then((cgroups) => cgroups?.browser(user))
    .catch(() => undefined)
  if (!cgroup) {
    await run('sudo', ['-n', HELPER, 'browser', ...args], { cwd: '/' })
    return
  }
  const child = spawn(
    'sh',
    ['-c', 'read -r _ <&3; exec "$@"', 'sh', 'sudo', '-n', HELPER, 'browser', ...args],
    {
      cwd: '/',
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)))
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const gate = child.stdio[3] as NodeJS.WritableStream
  gate.on('error', () => undefined)
  if (child.pid)
    await cgroup.attach(child.pid).catch((error: unknown) => {
      console.warn(`the browser of ${user} runs outside its cgroup: ${String(error)}`)
    })
  gate.end('\n')
  const code = await exited
  if (code !== 0) throw new Error(stderr.trim() || `The browser helper exited with ${code}`)
}

/** The last errors Chrome printed, from the log the helper keeps in the teammate's home. */
async function chromeErrors(user: string) {
  const { stdout } = await run(
    'sudo',
    ['-n', '-u', user, 'tail', '-c', '4000', chromeLog(teammateHome(user))],
    { cwd: '/' },
  ).catch(() => ({ stdout: '' }))
  return chromeLogErrors(stdout)
}

/**
 * Stop a teammate's browser: asked to quit, as closing it would, then whatever
 * is left of it killed. Its profile and sign-ins stay for its next start.
 */
export function stopBrowser(user: string) {
  if (starting.has(user)) return Promise.resolve()
  let stop = stopping.get(user)
  if (!stop) {
    stop = kill(user).finally(() => stopping.delete(user))
    stopping.set(user, stop)
  }
  return stop
}

const stopping = new Map<string, Promise<void>>()

async function kill(user: string) {
  const port = await portOf(user)
  // The pattern must not start with "-", which pkill would read as an option.
  const profile = `user-data-dir=${teammateHome(user)}/.browser`
  const signal = (name: string) =>
    run('sudo', ['-n', '-u', user, 'pkill', `-${name}`, '-u', user, '-f', profile], {
      cwd: '/',
    }).catch(() => undefined)
  await signal('TERM')
  for (let i = 0; i < 50 && (await listening(port)); i++)
    await new Promise((r) => setTimeout(r, 200))
  const cgroup = await runnerCgroups()
    .then((cgroups) => cgroups?.browser(user))
    .catch(() => undefined)
  await cgroup?.kill()
  await signal('KILL')
  lastUsed.delete(user)
}

/** The teammate users whose browser runs now (it listens on its port), from /etc/passwd. */
async function runningBrowsers() {
  const [passwd, tcp] = await Promise.all([
    readFile('/etc/passwd', 'utf8').catch(() => ''),
    readFile('/proc/net/tcp', 'utf8').catch(() => ''),
  ])
  return passwd.split('\n').flatMap((line) => {
    const [user, , uid] = line.split(':')
    if (!user?.startsWith('bt-') || !uid) return []
    uids.set(user, Number(uid))
    return listeningIn(tcp, PORT_BASE + Number(uid)) ? [user] : []
  })
}

/**
 * The running browsers to stop now: unused for `idleMs`, and none a person has
 * control of. One the runner never saw used (it started before the runner) is
 * counted from now.
 */
export function idleBrowsers(
  running: string[],
  used: Map<string, number>,
  now: number,
  inUse: (user: string) => boolean,
  idleMs = IDLE_MS,
) {
  for (const user of [...used.keys()]) if (!running.includes(user)) used.delete(user)
  return running.filter((user) => idle(user, used, now, inUse, idleMs))
}

function idle(
  user: string,
  used: Map<string, number>,
  now: number,
  inUse: (user: string) => boolean,
  idleMs: number,
) {
  if (inUse(user) || !used.has(user)) used.set(user, now)
  return now - used.get(user)! >= idleMs
}

/**
 * Stop the idle ones among the running browsers, one at a time. A stop takes up
 * to 10 s, during which another browser may be used or taken control of: each
 * is checked again right before it is stopped.
 */
export async function stopIdle(
  running: string[],
  used: Map<string, number>,
  inUse: (user: string) => boolean,
  stop: (user: string) => Promise<unknown>,
  now: () => number = Date.now,
  idleMs = IDLE_MS,
) {
  for (const user of idleBrowsers(running, used, now(), inUse, idleMs)) {
    if (!idle(user, used, now(), inUse, idleMs)) continue
    console.log(`stopping the browser of ${user}: unused for ${Math.round(idleMs / 60_000)} min`)
    await stop(user)
  }
}

/**
 * Stop the browsers nobody uses, checked every minute. `inUse` says whether a
 * person has control of one of the teammate's threads, using its browser on
 * the desktop.
 */
export function stopIdleBrowsers(inUse: (user: string) => boolean, every = 60_000) {
  let checking = false
  const timer = setInterval(() => {
    if (checking) return
    checking = true
    void runningBrowsers()
      .then((running) => stopIdle(running, lastUsed, inUse, stopBrowser))
      .catch((error: unknown) => console.warn(`could not stop idle browsers: ${String(error)}`))
      .finally(() => (checking = false))
  }, every)
  timer.unref()
  return () => clearInterval(timer)
}

/** The running browsers in cgroups of their own, for the memory guard; none a person has control of. */
export async function browserCandidates(inUse: (user: string) => boolean): Promise<Candidate[]> {
  const cgroups = await runnerCgroups()
  if (!cgroups) return []
  const users = (await runningBrowsers()).filter((user) => !inUse(user))
  return Promise.all(
    users.map(async (user) => {
      const cgroup = await cgroups.browser(user)
      return {
        kind: 'browser' as const,
        memory: await cgroup.resident(),
        lastUsed: lastUsed.get(user) ?? 0,
        stop: () => stopBrowser(user),
      }
    }),
  )
}

/** Opened when a person asks for the browser without a site in mind. */
export const BROWSER_START_PAGE = 'https://www.google.com/'

const PLAYWRIGHT_MCP = join(
  dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')),
  'cli.js',
)

const here = fileURLToPath(import.meta.url)
const RELAY = join(dirname(here), `browser-relay${extname(here)}`)
const FOCUS = join(dirname(here), `browser-focus${extname(here)}`)

/** Where the relay keeps the ids of the tabs a thread opened in the teammate's browser. */
export const threadTabsFile = (user: string, sessionId: string) =>
  `${teammateHome(user)}/.browser-tabs/${sessionId}.json`

/**
 * The harness's MCP server for the teammate's browser, in the shape both
 * Claude Code and Codex use natively. It reaches the browser through a relay
 * that gives each thread its own tabs.
 */
export const browserMcpServer = (port: number, tabsFile: string) => ({
  command: process.execPath,
  args: [RELAY, String(port), tabsFile, PLAYWRIGHT_MCP],
})

/**
 * Bring the thread's own tab to the front of the teammate's browser, if the
 * browser runs and the thread has a tab open in it.
 */
export async function focusThreadTab(teammateId: string, sessionId: string) {
  const user = teammateUser(teammateId)
  const port = await portOf(user)
  if (!(await listening(port))) return
  // People watch it on the desktop.
  touchBrowser(teammateId)
  await run(
    'sudo',
    ['-n', '-u', user, process.execPath, FOCUS, String(port), threadTabsFile(user, sessionId)],
    { cwd: '/', timeout: 15_000 },
  )
}
