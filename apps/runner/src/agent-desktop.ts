// agent-desktop (vercel-labs/agent-desktop): reads an app's interface through the OS's
// accessibility API (AX on macOS, AT-SPI on Linux) and acts on its elements by ref, without
// moving the pointer or taking focus. The runner ships it (a dependency, its binaries for each
// platform) and calls the one for its platform directly: the package's own launcher picks it at
// install time, and the runner's bundle is installed with no install scripts, built on Linux.
//
// Where it runs is the caller's (DesktopExec): on a member's Mac, through Brigade Computer Use,
// which holds Accessibility (harness/desktop-tools.ts); on a cloud computer, as the teammate's
// Linux user on the desktop, reading its own apps only (desktop.ts).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'

/** The binary for this platform, and on macOS the helper it starts (beside it). */
export type AgentDesktopBinary = { path: string; macosHelper?: string }

let found: AgentDesktopBinary | null | undefined

/** agent-desktop's binary for this computer, if the runner has it. */
export function agentDesktopBinary(
  os: NodeJS.Platform = platform(),
  cpu: string = arch(),
): AgentDesktopBinary | undefined {
  if (os === platform() && cpu === arch() && found !== undefined) return found ?? undefined
  let bin: string | undefined
  try {
    bin = join(dirname(createRequire(import.meta.url).resolve('agent-desktop/package.json')), 'bin')
  } catch {
    bin = undefined
  }
  const result = bin ? binaryIn(bin, os, cpu) : undefined
  if (os === platform() && cpu === arch()) found = result ?? null
  return result
}

/** The binary for `os` and `cpu` in the package's bin folder. */
export function binaryIn(bin: string, os: string, cpu: string): AgentDesktopBinary | undefined {
  if ((os !== 'darwin' && os !== 'linux') || (cpu !== 'arm64' && cpu !== 'x64')) return
  const path = join(bin, `agent-desktop-${os}-${cpu}`)
  if (!existsSync(path)) return
  if (os !== 'darwin') return { path }
  const macosHelper = join(bin, `agent-desktop-macos-helper-${os}-${cpu}`)
  return existsSync(macosHelper) ? { path, macosHelper } : undefined
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
  if (!envelope.ok) {
    const error = envelope.error ?? {}
    const code = error.code ?? 'failed'
    const retry =
      error.disposition?.retry === 'unsafe'
        ? ' It may have happened anyway: look before you try again.'
        : ''
    // Sentences, each ended once: agent-desktop's own end with a period, or don't.
    const sentence = (text: string) =>
      /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`
    const words = [error.message ?? `${args[0]} failed`, error.suggestion].filter(
      (text): text is string => !!text?.trim(),
    )
    throw new DesktopError(code, `${code}: ${words.map(sentence).join(' ')}${retry}`, error.details)
  }
  return envelope.data ?? {}
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
/** The most of a tree a tool gives back: past it, the teammate narrows the snapshot. */
export const TREE_MAX = 40_000

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

/**
 * A snapshot's tree as indented text, an element a line: far fewer tokens than its JSON, which
 * repeats every key. Elements hidden from the person (states: hidden) are left out with what
 * they hold, unless `hidden`. Past `max` characters it stops, and says how many it left out.
 */
export function renderTree(
  tree: DesktopNode | undefined,
  options: { hidden?: boolean; max?: number } = {},
) {
  const max = options.max ?? TREE_MAX
  const lines: string[] = []
  let size = 0
  let left = 0
  let hiddenLeft = 0
  const walk = (node: DesktopNode, depth: number) => {
    if (!options.hidden && node.states?.includes('hidden')) {
      hiddenLeft++
      return
    }
    const text = `${'  '.repeat(depth)}${line(node)}`
    if (size + text.length + 1 > max) left++
    else {
      lines.push(text)
      size += text.length + 1
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  if (tree) walk(tree, 0)
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
