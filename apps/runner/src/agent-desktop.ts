// agent-desktop (vercel-labs/agent-desktop): reads an app's interface through the OS's
// accessibility API (AX on macOS, AT-SPI on Linux) and acts on its elements by ref, without
// moving the pointer or taking focus.
//
// The runner's bundle doesn't carry it: its binaries for every platform (12 MB compressed) took
// the bundle past the 25 MiB a Worker asset may be, and the API serves the bundle as one (#849's
// deploy failed on it). A runner downloads the pinned version from npm the first time a teammate
// uses it, checks it against the integrity pinned here (the lockfile's), and keeps only the
// binaries for its own platform, beside the runner (<install dir>/agent-desktop/<version>), where a
// runner update leaves them and a cloud computer's teammate users can run them. In the repository
// (development, tests) the devDependency's copy is used.
//
// Where it runs is the caller's (DesktopExec): on a member's Mac, through Brigade Computer Use,
// which holds Accessibility (harness/desktop-tools.ts); on a cloud computer, as the teammate's
// Linux user on the desktop, reading its own apps only (desktop.ts).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The version used, and its npm tarball's integrity: the same as the devDependency's in the lockfile. */
export const AGENT_DESKTOP_VERSION = '1.3.1'
export const AGENT_DESKTOP_INTEGRITY =
  'sha512-5pBKkFkdB/VIAWRfqoA8lYp5/fenfxUHI15Pc4k8Nn2LmLxxo1PkAb0WLypknyOCczuIwuzFp/rZHGGawEV+hw=='
const TARBALL = `https://registry.npmjs.org/agent-desktop/-/agent-desktop-${AGENT_DESKTOP_VERSION}.tgz`

/** Where a runner keeps its download: beside the runner (<install dir>/runner), not inside it. */
export const AGENT_DESKTOP_DIR = join(
  dirname(fileURLToPath(new URL('..', import.meta.url))),
  'agent-desktop',
  AGENT_DESKTOP_VERSION,
)

/** The binary for this platform, and on macOS the helper it starts (beside it). */
export type AgentDesktopBinary = { path: string; macosHelper?: string }

/** agent-desktop's binary for this computer, if the runner has it already (no download). */
export function agentDesktopBinary(
  os: NodeJS.Platform = platform(),
  cpu: string = arch(),
  dir = AGENT_DESKTOP_DIR,
  /** The devDependency's copy first, where there is one (the repository). */
  fromPackage = true,
): AgentDesktopBinary | undefined {
  let bin: string | undefined
  try {
    bin = fromPackage
      ? join(dirname(createRequire(import.meta.url).resolve('agent-desktop/package.json')), 'bin')
      : undefined
  } catch {
    bin = undefined
  }
  return (bin ? binaryIn(bin, os, cpu) : undefined) ?? binaryIn(dir, os, cpu)
}

/** The binary for `os` and `cpu` in the package's bin folder. */
export function binaryIn(bin: string, os: string, cpu: string): AgentDesktopBinary | undefined {
  const names = binaryNames(os, cpu)
  if (!names) return
  const path = join(bin, names[0]!)
  if (!existsSync(path)) return
  if (os !== 'darwin') return { path }
  const macosHelper = join(bin, names[1]!)
  return existsSync(macosHelper) ? { path, macosHelper } : undefined
}

/** The files a platform needs, the binary first; none for a platform agent-desktop doesn't run on. */
function binaryNames(os: string, cpu: string) {
  if ((os !== 'darwin' && os !== 'linux') || (cpu !== 'arm64' && cpu !== 'x64')) return
  return os === 'darwin'
    ? [`agent-desktop-${os}-${cpu}`, `agent-desktop-macos-helper-${os}-${cpu}`]
    : [`agent-desktop-${os}-${cpu}`, `agent-desktop-linux-clipboard-owner-${os}-${cpu}`]
}

let downloading: Promise<AgentDesktopBinary> | undefined

/** The longest a download may take, its body included: a stalled one fails, and the next call tries again. */
export const DOWNLOAD_DEADLINE_MS = 120_000

/**
 * agent-desktop's binary for this computer, downloaded first if the runner hasn't it yet. One
 * download at a time, which fails past its deadline; a failed one is tried again at the next
 * call. A caller's `signal` stops its own wait only: the download goes on for the others.
 */
export function ensureAgentDesktop(
  options: {
    os?: NodeJS.Platform
    cpu?: string
    dir?: string
    fetch?: typeof fetch
    /** Tests: the integrity their own tarball has, and no devDependency's copy. */
    integrity?: string
    fromPackage?: boolean
    deadlineMs?: number
    signal?: AbortSignal
  } = {},
): Promise<AgentDesktopBinary> {
  const os = options.os ?? platform()
  const cpu = options.cpu ?? arch()
  const dir = options.dir ?? AGENT_DESKTOP_DIR
  const have = agentDesktopBinary(os, cpu, dir, options.fromPackage ?? true)
  if (have) return Promise.resolve(have)
  const integrity = options.integrity ?? AGENT_DESKTOP_INTEGRITY
  const signal = options.signal
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  downloading ??= withDeadline(
    (deadline) => download(os, cpu, dir, options.fetch ?? fetch, integrity, deadline),
    options.deadlineMs ?? DOWNLOAD_DEADLINE_MS,
  ).finally(() => {
    downloading = undefined
  })
  const shared = downloading
  if (!signal) return shared
  return new Promise<AgentDesktopBinary>((resolve, reject) => {
    const abort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * `work` given a signal that aborts at the deadline, and failing then whether or not it heeds it
 * (a fetch does, body included; anything else is left behind).
 */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number) {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `agent-desktop could not be downloaded: no answer from npm within ${Math.round(ms / 1000)} seconds`,
      )
      controller.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([work(controller.signal), late]).finally(() => clearTimeout(timer))
}

async function download(
  os: NodeJS.Platform,
  cpu: string,
  dir: string,
  get: typeof fetch,
  pinned: string,
  deadline: AbortSignal,
) {
  const names = binaryNames(os, cpu)
  if (!names) throw new Error(`agent-desktop does not run on ${os} ${cpu}`)
  const response = await get(TARBALL, { signal: deadline }).catch((error: unknown) => {
    throw new Error(`agent-desktop could not be downloaded: ${String(error)}`)
  })
  if (!response.ok)
    throw new Error(`agent-desktop could not be downloaded: npm answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  // Past the deadline already: what comes after (writing, unpacking) isn't started.
  if (deadline.aborted) throw deadline.reason
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== pinned)
    throw new Error('agent-desktop was not used: its download does not match the version pinned')
  // Unpacked next to where it goes, then moved there whole: a runner stopped halfway leaves no
  // half-written binary where the next look would find it.
  await mkdir(dirname(dir), { recursive: true, mode: 0o755 })
  const staging = await mkdtemp(`${dir}.`)
  try {
    const tarball = join(staging, 'package.tgz')
    await writeFile(tarball, bytes)
    await run('tar', [
      '-xzf',
      tarball,
      '-C',
      staging,
      ...names.map((name) => `package/bin/${name}`),
    ])
    const unpacked = join(staging, 'package', 'bin')
    for (const name of names) await chmod(join(unpacked, name), 0o755)
    await chmod(unpacked, 0o755)
    await rm(dir, { recursive: true, force: true })
    await rename(unpacked, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const binary = binaryIn(dir, os, cpu)
  if (!binary) throw new Error('agent-desktop was downloaded, but its binary is missing')
  return binary
}

/** Runs agent-desktop with these arguments where the caller says; resolves to its stdout. */
export type DesktopExec = (
  args: string[],
  options?: { stdin?: string; signal?: AbortSignal },
) => Promise<string>

/** What each command prints: one JSON envelope. */
export type Envelope = {
  ok: boolean
  command?: string
  data?: Record<string, unknown>
  error?: {
    code?: string
    message?: string
    suggestion?: string
    details?: unknown
    disposition?: { delivery?: string; retry?: string }
  }
}

export class DesktopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** The envelope in a command's output, or an error saying what came instead. */
export function parseEnvelope(stdout: string): Envelope {
  const text = stdout.trim()
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    // A notice on a line before it (the package's launcher prints one): the last line is the JSON.
    const last = text.split('\n').pop() ?? ''
    try {
      envelope = JSON.parse(last)
    } catch {
      throw new DesktopError(
        'unreadable',
        `agent-desktop printed no answer${text ? `: ${text.slice(-500)}` : ''}`,
      )
    }
  }
  if (!envelope || typeof envelope !== 'object' || typeof (envelope as Envelope).ok !== 'boolean')
    throw new DesktopError(
      'unreadable',
      `agent-desktop printed an unexpected answer: ${text.slice(0, 500)}`,
    )
  return envelope as Envelope
}

/** Run a command and return its data; a refusal is a DesktopError with agent-desktop's own words. */
export async function desktopCall(
  exec: DesktopExec,
  args: string[],
  options?: { stdin?: string; signal?: AbortSignal },
) {
  const envelope = parseEnvelope(await exec(args, options))
  if (!envelope.ok) throw refusal(envelope.error, args[0] ?? 'command')
  return envelope.data ?? {}
}

/** agent-desktop's refusal as a DesktopError, in its own words. */
function refusal(error: Envelope['error'] = {}, command: string) {
  const code = error.code ?? 'failed'
  const retry =
    error.disposition?.retry === 'unsafe'
      ? ' It may have happened anyway: look before you try again.'
      : ''
  // Sentences, each ended once: agent-desktop's own end with a period, or don't.
  const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)
  const words = [error.message ?? `${command} failed`, error.suggestion].filter(
    (text): text is string => !!text?.trim(),
  )
  return new DesktopError(code, `${code}: ${words.map(sentence).join(' ')}${retry}`, error.details)
}

/** A command in agent-desktop's batch, with its arguments by their own field names. */
export type BatchEntry = { command: string; args: Record<string, unknown> }

/** What one command of a batch did: its data, or its refusal. */
export type BatchResult =
  { ok: true; data: Record<string, unknown> } | { ok: false; error: DesktopError }

/**
 * Several commands in one agent-desktop process, in order, stopping at the first refusal: one
 * trip through Brigade Computer Use rather than one each. The JSON goes on the command line, so
 * it never carries text to type (that goes through stdin, one action at a time). The results
 * stop where the batch stopped.
 */
export async function desktopBatch(
  exec: DesktopExec,
  entries: BatchEntry[],
  options: { headed?: boolean; signal?: AbortSignal } = {},
): Promise<BatchResult[]> {
  const data = await desktopCall(
    exec,
    [...(options.headed ? ['--headed'] : []), 'batch', JSON.stringify(entries), '--stop-on-error'],
    options.signal ? { signal: options.signal } : {},
  )
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : []
  return results.map((result, index) =>
    result.ok === true
      ? { ok: true, data: (result.data as Record<string, unknown> | undefined) ?? {} }
      : {
          ok: false,
          error: refusal(
            (result.error as Envelope['error']) ?? {},
            entries[index]?.command ?? 'command',
          ),
        },
  )
}

/** An element of a snapshot's tree, as agent-desktop gives it. */
export type DesktopNode = {
  role?: string
  name?: string
  value?: unknown
  description?: string
  placeholder?: string
  states?: string[]
  available_actions?: string[]
  ref_id?: string
  children_count?: number
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  children?: DesktopNode[]
}

const TEXT_MAX = 160
/**
 * The most of a tree a tool gives back: past it, the teammate narrows the snapshot. Each
 * character is read by the model at every later step of the turn, so a big window (a file
 * dialog listing a home folder ran to 40 KB, three times) slowed a whole test down.
 */
export const TREE_MAX = 15_000
/** The children of one element shown before the rest is summed up in a line (a long list). */
export const CHILDREN_MAX = 25
/** Siblings scrolled out of view in a row, from which they are summed up in a line. */
const OUT_OF_VIEW_RUN = 3

const short = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TEXT_MAX ? `${one.slice(0, TEXT_MAX)}…` : one
}

/** Actions shown as the act tool names them (Click → click, RightClick → right_click). */
const actionName = (action: string) =>
  action
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/\s+/g, '_')
    .toLowerCase()

/** One line for an element: role, name, value, states, ref and what it can do. */
function line(node: DesktopNode) {
  const parts = [node.role || 'element']
  if (node.name) parts.push(JSON.stringify(short(node.name)))
  if (node.value !== undefined && node.value !== null && node.value !== '')
    parts.push(`= ${JSON.stringify(short(String(node.value)))}`)
  if (node.placeholder) parts.push(`placeholder ${JSON.stringify(short(node.placeholder))}`)
  if (node.description && node.description !== node.name) parts.push(`(${short(node.description)})`)
  const states = (node.states ?? []).filter((state) => state !== 'hidden')
  if (states.length) parts.push(`[${states.join(', ')}]`)
  if (node.ref_id) parts.push(node.ref_id)
  const actions = (node.available_actions ?? []).map(actionName)
  if (node.ref_id && actions.length) parts.push(`{${actions.join(', ')}}`)
  if (node.bounds && node.bounds.width !== undefined)
    parts.push(
      `<${Math.round(node.bounds.x ?? 0)},${Math.round(node.bounds.y ?? 0)} ${Math.round(node.bounds.width)}×${Math.round(node.bounds.height ?? 0)}>`,
    )
  if (node.children_count && !node.children?.length) parts.push(`(${node.children_count} inside)`)
  return parts.join(' ')
}

const offscreen = (node: DesktopNode) => !!node.states?.includes('offscreen')

/**
 * A snapshot's tree as indented text, an element a line: far fewer tokens than its JSON, which
 * repeats every key. Elements hidden from the person (states: hidden) are left out with what
 * they hold, and a run of siblings scrolled out of view is one line saying how many, unless
 * `hidden`. An element shows its first `children` children (CHILDREN_MAX by default), then a
 * line for the rest. Past `max` characters it stops, and says how many it left out.
 */
export function renderTree(
  tree: DesktopNode | undefined,
  options: { hidden?: boolean; max?: number; children?: number } = {},
) {
  const max = options.max ?? TREE_MAX
  const childrenMax = options.children ?? CHILDREN_MAX
  const lines: string[] = []
  let size = 0
  let left = 0
  let hiddenLeft = 0
  const push = (text: string) => {
    if (size + text.length + 1 > max) {
      left++
      return
    }
    lines.push(text)
    size += text.length + 1
  }
  const walk = (node: DesktopNode, depth: number) => {
    push(`${'  '.repeat(depth)}${line(node)}`)
    const indent = '  '.repeat(depth + 1)
    const children = (node.children ?? []).filter((child) => {
      if (options.hidden || !child.states?.includes('hidden')) return true
      hiddenLeft++
      return false
    })
    let shown = 0
    for (let i = 0; i < children.length; i++) {
      if (shown >= childrenMax) {
        const rest = children.length - i
        push(
          `${indent}… ${rest} more here${node.ref_id ? `: snapshot with root ${node.ref_id} to list them` : ''}`,
        )
        break
      }
      // Siblings scrolled out of view, in a row: one line, the way to them, not each of them.
      if (!options.hidden && offscreen(children[i]!)) {
        let end = i
        while (end < children.length && offscreen(children[end]!)) end++
        if (end - i >= OUT_OF_VIEW_RUN) {
          push(`${indent}… ${end - i} out of view (scroll to them, or snapshot with hidden: true)`)
          shown++
          i = end - 1
          continue
        }
      }
      walk(children[i]!, depth + 1)
      shown++
    }
  }
  if (tree) {
    if (!options.hidden && tree.states?.includes('hidden')) hiddenLeft++
    else walk(tree, 0)
  }
  return { text: lines.join('\n'), left, hidden: hiddenLeft }
}

/** Arguments that pick the app and window a command is about. */
export function targetArgs(input: { app?: string; window?: string }) {
  return [
    ...(input.app ? ['--app', input.app] : []),
    ...(input.window ? ['--window-id', input.window] : []),
  ]
}

/** Quote for a POSIX shell, as one word. */
export const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`
