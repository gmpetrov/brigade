// The environment harness processes run with. Brigade sets no API key: with
// none present, the vendor CLIs use their own subscription logins.
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
