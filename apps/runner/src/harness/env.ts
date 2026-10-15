// The environment harness processes run with. Brigade sets no API key: the
// vendor CLIs use their own subscription logins, and a turn on a Claude account
// with a token gets it explicitly (accountEnv).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** API keys never reach a harness. */
const API_KEYS =
  /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|AI_GATEWAY_|VERCEL_OIDC_TOKEN$|OPENAI_API_KEY$|CODEX_API_KEY$)/
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

const MARK = '__BRIGADE_PATH__'

/**
 * On a Mac, where the person's shell finds commands, before what the runner was given:
 * Brigade.app starts it from Finder with a short PATH, and the harness CLIs live
 * elsewhere (claude in ~/.local/bin, a Node version manager's bin). Asks the login
 * shell, then adds the places installers use, so `claude` and `codex` are found.
 */
export function usePersonPath(): void {
  if (process.platform !== 'darwin') return
  let shellPath = ''
  try {
    const out = execFileSync(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    shellPath = out.split(MARK)[1] ?? ''
  } catch {}
  const home = homedir()
  const dirs = [
    ...shellPath.split(delimiter),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH ?? '').split(delimiter),
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
  env.PATH = [SHIM_DIR, dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter)
  return { ...env, ...extra }
}
