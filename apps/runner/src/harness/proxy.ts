// A Mac's proxy, for what the runner starts. Brigade.app starts the runner from Finder, without
// the person's shell, and Node reads neither the shell's `https_proxy` nor macOS's system proxy:
// on a Mac that reaches the internet only through a proxy set in System Settings (as a VPN app's
// "system proxy" mode does), the app's window got through and Claude Code, under the runner, was
// refused at once ("Connection refused") on every turn. Harness processes get the person's
// proxy as environment variables, which Claude Code and Codex both read.
import { execFileSync } from 'node:child_process'

/** The variables a proxy is set with, in either case: curl reads only the lower-case ones. */
export const PROXY_VARS = /^(https?|all|no)_proxy$/i

/** Whether the environment names a proxy already (a `no_proxy` alone names none). */
export const namesProxy = (env: Record<string, string | undefined>) =>
  Object.entries(env).some(([key, value]) => value && PROXY_VARS.test(key) && !/^no_/i.test(key))

/** The proxy variables among `KEY=value` lines (what `env` prints). */
export function proxyVarsIn(lines: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of lines.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1).trim()
    if (PROXY_VARS.test(key) && value) vars[key] = value
  }
  return vars
}

/** Always straight: the computer itself, whatever the system's list leaves out. */
const LOCAL = ['localhost', '127.0.0.1', '::1']

/**
 * The proxy of `scutil --proxy`'s answer, as variables: its HTTPS proxy, else its HTTP one.
 * None for a SOCKS proxy or a proxy script (PAC) alone: Claude Code takes neither.
 */
export function parseScutilProxy(text: string): Record<string, string> | undefined {
  const value = (key: string) => text.match(new RegExp(`^\\s*${key} : (.+)$`, 'm'))?.[1]?.trim()
  const proxy = (kind: 'HTTPS' | 'HTTP') => {
    const host = value(`${kind}Proxy`)
    const port = value(`${kind}Port`)
    if (value(`${kind}Enable`) !== '1' || !host) return undefined
    return `http://${host.includes(':') ? `[${host}]` : host}${port ? `:${port}` : ''}`
  }
  const https = proxy('HTTPS') ?? proxy('HTTP')
  if (!https) return undefined
  const http = proxy('HTTP') ?? https
  // Hosts the system sends straight ("*.local", "169.254/16"): no_proxy takes names and
  // suffixes, so a wildcard becomes its suffix and a network range is left out.
  const block = text.match(/ExceptionsList : <array> \{([\s\S]*?)\}/)?.[1] ?? ''
  const exceptions = [...block.matchAll(/^\s*\d+ : (.+)$/gm)]
    .map((m) => m[1]!.trim().replace(/^\*\./, '.'))
    .filter((host) => host && !host.includes('/') && !host.includes('*'))
  const none = [...new Set([...LOCAL, ...exceptions])].join(',')
  return {
    HTTPS_PROXY: https,
    https_proxy: https,
    HTTP_PROXY: http,
    http_proxy: http,
    NO_PROXY: none,
    no_proxy: none,
  }
}

/** How long a read of the system's proxy is kept: a VPN app turned on comes in that soon. */
const KEEP_MS = 30_000
let read: { at: number; vars: Record<string, string> | undefined } | undefined

/** macOS's system proxy now, as variables; none off a Mac or with none set. */
export function systemProxy(now = Date.now()): Record<string, string> | undefined {
  if (process.platform !== 'darwin') return undefined
  if (read && now - read.at < KEEP_MS) return read.vars
  let vars: Record<string, string> | undefined
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    vars = parseScutilProxy(out)
  } catch {}
  read = { at: now, vars }
  return vars
}

/**
 * The environment with the system's proxy added, unless it names one already: the runner's own,
 * or the person's shell's (usePersonPath), which win as they would in their terminal.
 */
export function withSystemProxy(
  env: Record<string, string>,
  system: () => Record<string, string> | undefined = systemProxy,
): Record<string, string> {
  if (namesProxy(env)) return env
  const vars = system()
  if (!vars) return env
  // Hosts the person sends straight already stay straight.
  const own = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(',')
  const none = [...new Set([...own.split(','), ...vars.NO_PROXY!.split(',')])]
    .map((host) => host.trim())
    .filter(Boolean)
    .join(',')
  return { ...env, ...vars, NO_PROXY: none, no_proxy: none }
}
