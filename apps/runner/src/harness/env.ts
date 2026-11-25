// The environment harness processes run with. Brigade sets no API key: the
// vendor CLIs use their own subscription logins, and a turn on a Claude account
// with a token gets it explicitly (accountEnv).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { agentDesktopBinary, shellQuote } from '../agent-desktop.js'
import { pathKey } from '../windows.js'
import { namesProxy, proxyVarsIn, withCallerProxy, withSystemProxy } from './proxy.js'

/** API keys never reach a harness. */
const API_KEYS =
  /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|AI_GATEWAY_|VERCEL_OIDC_TOKEN$|OPENAI_API_KEY$|CODEX_API_KEY$|GEMINI_API_KEY$)/
/** The runner's own settings stay with the runner. */
const RUNNER_ONLY = /^BRIGADE_/

// The adapters install their bridge with pnpm; the runner ships its own pinned
// copy and exposes it through a small shim, since installed bundles have no .bin links.
// On a cloud computer this sits beside the runner, where teammate users can run it.
const SHIM_DIR =
  process.env.BRIGADE_SHIM_DIR ??
  join(process.env.BRIGADE_HOME ?? join(homedir(), '.brigade'), 'bin', 'shims')

function ensurePnpmShim() {
  const shim = join(SHIM_DIR, 'pnpm')
  if (existsSync(shim)) return
  const require = createRequire(import.meta.url)
  // pnpm exports its package.json as the package entry.
  const pnpmDir = dirname(require.resolve('pnpm'))
  mkdirSync(SHIM_DIR, { recursive: true, mode: 0o755 })
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${join(pnpmDir, 'bin', 'pnpm.cjs')}" "$@"\n`,
    { mode: 0o755 },
  )
}

/**
 * On a Mac, `agent-desktop` for commands run through Brigade Computer Use (computer_run), which
 * gives it Accessibility: the runner's own copy, the one computer_snapshot and computer_act use.
 * Not when the person has one of their own on their PATH: theirs stays the one found.
 */
export function ensureAgentDesktopShim(
  path = process.env.PATH ?? '',
  dir = SHIM_DIR,
  binary = process.platform === 'darwin' ? agentDesktopBinary() : undefined,
) {
  if (!binary?.macosHelper) return
  const shim = join(dir, 'agent-desktop')
  const content =
    `#!/bin/sh\n# Brigade's agent-desktop\nAGENT_DESKTOP_MACOS_HELPER_PATH=${shellQuote(binary.macosHelper)} ` +
    `exec ${shellQuote(binary.path)} "$@"\n`
  if (path.split(delimiter).some((d) => d && d !== dir && existsSync(join(d, 'agent-desktop')))) {
    // Theirs, installed since: ours goes, or it would come first.
    if (existsSync(shim) && readFileSync(shim, 'utf8').includes("# Brigade's agent-desktop"))
      rmSync(shim, { force: true })
    return
  }
  // A runner update may move its copy: the shim follows it.
  if (existsSync(shim) && readFileSync(shim, 'utf8') === content) return
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  writeFileSync(shim, content, { mode: 0o755 })
}

const MARK = '__BRIGADE_PATH__'
const PROXY_MARK = '__BRIGADE_PROXY__'

/**
 * What the login shell answers `printf … "$PATH"; env`: its PATH, and the proxy it sets
 * (`export https_proxy=…` in ~/.zshrc), between their marks, whatever it prints around them.
 */
export function personShell(out: string): { path: string; proxy: Record<string, string> } {
  return {
    path: out.split(MARK)[1] ?? '',
    proxy: proxyVarsIn(out.split(PROXY_MARK)[1] ?? ''),
  }
}

/**
 * On a Mac, where the person's shell finds commands, before what the runner was given:
 * Brigade.app starts it from Finder with a short PATH, and the harness CLIs live
 * elsewhere (claude in ~/.local/bin, a Node version manager's bin). Asks the login
 * shell, then adds the places installers use, so `claude` and `codex` are found.
 * The proxy that shell sets comes along, unless the runner was given one: in a terminal,
 * `claude` would go through it (harness/proxy.ts).
 */
export function usePersonPath(): void {
  if (process.platform !== 'darwin') return
  let shellPath = ''
  try {
    const out = execFileSync(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', `printf '${MARK}%s${MARK}${PROXY_MARK}' "$PATH"; env; printf '${PROXY_MARK}'`],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const shell = personShell(out)
    shellPath = shell.path
    if (!namesProxy(process.env)) Object.assign(process.env, shell.proxy)
  } catch {}
  const home = homedir()
  const dirs = [
    ...shellPath.split(delimiter),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH ?? '').split(delimiter),
    // Last, so a codex of their own comes first: the one the ChatGPT app ships, for a Mac with
    // only that app.
    ...['/Applications', join(home, 'Applications')].map((apps) =>
      join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
    ),
  ]
  process.env.PATH = [...new Set(dirs.filter(Boolean))].join(delimiter)
}

/** Remove API keys from the runner's own environment. */
export function stripApiKeys(): void {
  for (const key of Object.keys(process.env)) if (API_KEYS.test(key)) delete process.env[key]
}

export function harnessEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !API_KEYS.test(key) && !RUNNER_ONLY.test(key)) env[key] = value
  }
  ensurePnpmShim()
  try {
    ensureAgentDesktopShim()
  } catch (error) {
    console.warn(`could not write the agent-desktop shim: ${String(error)}`)
  }
  // Windows names it Path, and two of them would leave the child either one.
  const key = pathKey(env)
  const path = env[key]
  delete env[key]
  env.PATH = [SHIM_DIR, dirname(process.execPath), path].filter(Boolean).join(delimiter)
  // On a Mac, the system's proxy when nothing names one, the caller's included: a proxy or
  // no_proxy of its own wins, in both cases, as curl reads the lower-case one first (harness/proxy.ts).
  return withSystemProxy(withCallerProxy(env, extra))
}
