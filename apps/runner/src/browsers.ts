// Each teammate's browser on a workspace cloud computer: one Chrome per
// teammate, as its Linux user, with its own profile in its home. Its sign-ins
// persist there for all of the teammate's threads. The harness drives it
// through Playwright's MCP server; a person uses the same windows on the
// desktop during takeover.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { teammateUser } from './teammates.js'

const run = promisify(execFile)
const HELPER = '/usr/local/sbin/brigade-teammate'

/** The debugging port of a teammate's browser, from its uid. The helper lets only that uid connect. */
async function portOf(user: string) {
  const { stdout } = await run('id', ['-u', user], { cwd: '/' })
  return 20_000 + Number(stdout.trim())
}

/** Whether something listens on 127.0.0.1:port, read from /proc (connecting is firewalled). */
async function listening(port: number) {
  const table = await readFile('/proc/net/tcp', 'utf8').catch(() => '')
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
export async function ensureBrowser(teammate: { id: string; name: string }, url?: string) {
  const user = teammateUser(teammate.id)
  const port = await portOf(user)
  // The window title tells people on the desktop whose browser this is.
  const title = `${teammate.name.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) || 'Teammate'} browser`
  if (url || !(await listening(port))) {
    await run('sudo', ['-n', HELPER, 'browser', user, String(port), title, ...(url ? [url] : [])], {
      cwd: '/',
    })
  }
  for (let i = 0; i < 50 && !(await listening(port)); i++)
    await new Promise((r) => setTimeout(r, 200))
  if (!(await listening(port))) throw new Error(`The browser of ${user} did not start`)
  return port
}

/** Opened when a person asks for the browser without a site in mind. */
export const BROWSER_START_PAGE = 'https://www.google.com/'

const PLAYWRIGHT_MCP = join(
  dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')),
  'cli.js',
)

const here = fileURLToPath(import.meta.url)
const RELAY = join(dirname(here), `browser-relay${extname(here)}`)

/**
 * The harness's MCP server for the teammate's browser, in the shape both
 * Claude Code and Codex use natively. It reaches the browser through a relay
 * that gives each thread its own tabs.
 */
export const browserMcpServer = (port: number, tabsFile: string) => ({
  command: process.execPath,
  args: [RELAY, String(port), tabsFile, PLAYWRIGHT_MCP],
})
