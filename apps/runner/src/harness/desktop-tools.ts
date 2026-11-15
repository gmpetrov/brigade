// Computer use by accessibility refs, through agent-desktop (../agent-desktop.ts): read an app's
// interface as a tree whose elements have refs, then act on a ref. Ref actions go through the
// accessibility API: they don't move the pointer or take the keyboard focus, so on a member's
// Mac they don't get in the way of the person working at it.
//
// On a Mac they sit beside the screenshot-and-click tools (tools.ts's computerUseTools), which
// stay for what the tree doesn't show. On a cloud computer they reach the teammate's own browser
// windows: Chrome's own interface (a permission prompt, a sign-in dialog, its menus), which the
// browser tools, made for web pages, don't. There, text goes in with the desktop's keyboard where
// a field takes none through accessibility (Chrome's own fields don't), and keys too: agent-desktop
// can't bring a teammate's browser window to the front itself, since it matches windows by title
// and the helper names each browser's window after its teammate.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonSchema, tool, type Tool } from 'ai'
import {
  DesktopError,
  desktopCall,
  renderTree,
  shellQuote,
  targetArgs,
  type AgentDesktopBinary,
  type DesktopExec,
  type DesktopNode,
} from '../agent-desktop.js'
import { ComputerUseError } from '../computer-use.js'
import type { ComputerUse } from './tools.js'

/** The desktop's keyboard, into the teammate's browser window, brought to the front first. */
export type Keyboard = {
  type: (text: string, signal?: AbortSignal) => Promise<void>
  /** A key or a combination, in xdotool's names (ctrl+l, Escape, Return). */
  key: (combo: string, signal?: AbortSignal) => Promise<void>
}

export type Desktop = {
  exec: DesktopExec
  /** A member's Mac, or a cloud computer's desktop (the teammate's own browser). */
  where: 'mac' | 'cloud'
  /** Before each call: on a cloud computer, the teammate's browser started. */
  ready?: (signal?: AbortSignal) => Promise<void>
  /** On a cloud computer: what agent-desktop can't type or press there. */
  keyboard?: Keyboard
}

/** The teammate's browser, as agent-desktop names it on Linux. */
const CLOUD_APP = 'chrome'

const ABOUT = {
  mac:
    "On the person's own Mac (this computer), through Brigade Computer Use: while you act, a pill on " +
    'their screen shows your name with a Stop button.',
  cloud:
    "On this cloud computer's desktop, in your own browser's windows only: Chrome's own interface, which " +
    'the browser_* tools do not reach (a permission prompt, a sign-in dialog, a bubble such as "Save ' +
    "password?\", its menus and settings, an extension's popup). For a web page's content, the " +
    'browser_* tools come first.',
}

const ACTIONS = [
  'click',
  'right_click',
  'double_click',
  'type',
  'set_value',
  'clear',
  'focus',
  'select',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse',
  'scroll',
  'scroll_to',
] as const
type Action = (typeof ACTIONS)[number]

/** What a cloud computer's desktop takes: pointer gestures there need the browser's window found. */
const CLOUD_ACTIONS = ACTIONS.filter((action) => action !== 'double_click')

export type SnapshotInput = {
  app?: string
  window?: string
  root?: string
  skeleton?: boolean
  all?: boolean
  hidden?: boolean
  bounds?: boolean
  surface?: string
  maxDepth?: number
}

export type ActInput = {
  ref: string
  action: Action
  text?: string
  option?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  headed?: boolean
}

/** The surfaces agent-desktop reads on each: a Mac has a focused element and popovers, Linux not. */
const SURFACES = {
  mac: ['window', 'focused', 'menu', 'menubar', 'sheet', 'popover', 'alert'],
  cloud: ['window', 'menu', 'sheet', 'alert'],
} as const

/** The windows agent-desktop lists when a command matched several: their ids and titles. */
export function windowsIn(details: unknown) {
  const found: { id: string; title?: string }[] = []
  const seen = new Set<string>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const id = record.window_id ?? record.id
    if (typeof id === 'string' && /^w-/.test(id)) {
      if (!seen.has(id)) {
        seen.add(id)
        found.push({ id, ...(typeof record.title === 'string' ? { title: record.title } : {}) })
      }
      return
    }
    Object.values(record).forEach(walk)
  }
  walk(details)
  return found.slice(0, 20)
}

/** A refusal as the teammate reads it: agent-desktop's words, and the windows to pick from. */
export function explain(error: unknown, where: Desktop['where']): never {
  if (!(error instanceof DesktopError)) throw error
  const windows = windowsIn(error.details)
  if (windows.length)
    throw new Error(
      `${error.message}\nWindows (pass one as window): ${windows
        .map((w) => `${w.id}${w.title ? ` "${w.title}"` : ''}`)
        .join('; ')}`,
    )
  if (
    where === 'cloud' &&
    (error.code === 'APP_NOT_FOUND' || error.code === 'PLATFORM_NOT_SUPPORTED')
  )
    throw new Error(
      `${error.message}\nYour browser can be read once it started with this computer's current setup: ` +
        'one that was already running is read after its next start (it stops after 15 minutes unused). ' +
        'Use the browser_* tools meanwhile.',
    )
  throw new Error(error.message)
}

/** The surfaces an action left open (a menu, a dialog), as agent-desktop lists them. */
function surfacesOf(data: Record<string, unknown>) {
  const surfaces = Array.isArray(data.surfaces) ? (data.surfaces as Record<string, unknown>[]) : []
  return surfaces.slice(0, 20).map((surface) => ({
    type: surface.type,
    ...(surface.title ? { title: surface.title } : {}),
    ...(surface.id ? { window: surface.id } : {}),
  }))
}

/** The arguments for an action on a ref, and the text it reads from stdin. */
export function actArgs(input: ActInput): { args: string[]; stdin?: string } {
  const headed = input.headed ? ['--headed'] : []
  const ref = input.ref
  switch (input.action) {
    case 'type':
    case 'set_value':
      if (input.text === undefined) throw new Error(`text is required to ${input.action}`)
      // From stdin: the text stays out of the process's arguments, which every process can read.
      return {
        args: [...headed, input.action === 'type' ? 'type' : 'set-value', ref, '--stdin'],
        stdin: input.text,
      }
    case 'select':
      if (!input.option) throw new Error('option is required to select')
      return { args: [...headed, 'select', ref, input.option] }
    case 'scroll':
      return {
        args: [
          ...headed,
          'scroll',
          ref,
          '--direction',
          input.direction ?? 'down',
          '--amount',
          String(Math.min(Math.max(Math.round(input.amount ?? 3), 1), 50)),
        ],
      }
    default:
      return { args: [...headed, input.action.replace(/_/g, '-'), ref] }
  }
}

/** The arguments for a snapshot. */
export function snapshotArgs(input: SnapshotInput, where: Desktop['where']) {
  const app = input.app ?? (where === 'cloud' && !input.window ? CLOUD_APP : undefined)
  return [
    'snapshot',
    ...targetArgs({ ...(app ? { app } : {}), ...(input.window ? { window: input.window } : {}) }),
    ...(input.all ? [] : ['-i']),
    '--compact',
    ...(input.root ? ['--root', input.root] : []),
    ...(input.skeleton ? ['--skeleton'] : []),
    ...(input.bounds ? ['--include-bounds'] : []),
    ...(input.surface && input.surface !== 'window' ? ['--surface', input.surface] : []),
    ...(input.maxDepth
      ? ['--max-depth', String(Math.min(Math.max(Math.round(input.maxDepth), 1), 50))]
      : []),
    // Chromium and Electron apps settle slowly: agent-desktop's 3 seconds read them thin.
    '--timeout-ms',
    '8000',
  ]
}

/** A window as list-windows gives it. */
type WindowInfo = {
  id?: string
  title?: string
  is_focused?: boolean
  minimized?: boolean
  visible?: boolean
  bounds?: { width?: number; height?: number }
}

/**
 * The window of the teammate's browser to read when none is named: it has several (each window a
 * person or a thread opened, and Chrome's popups, which have no title). The one with the focus,
 * else the biggest titled one, else the biggest. The others are listed, to pick one by its id.
 */
export function pickWindow(windows: WindowInfo[]) {
  const shown = windows.filter((w) => w.id && w.visible !== false && !w.minimized)
  const area = (w: WindowInfo) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0)
  const titled = shown.filter((w) => w.title)
  const chosen =
    titled.find((w) => w.is_focused) ??
    [...titled].sort((a, b) => area(b) - area(a))[0] ??
    shown.find((w) => w.is_focused) ??
    [...shown].sort((a, b) => area(b) - area(a))[0]
  const others = titled
    .filter((w) => w !== chosen)
    .map((w) => ({ id: w.id!, title: w.title! }))
    .slice(0, 20)
  return { chosen: chosen?.id, others }
}

/** Refusals that mean the element takes no text through accessibility (Chrome's own fields). */
const NO_SEMANTIC_TEXT = new Set(['POLICY_DENIED', 'ACTION_NOT_SUPPORTED'])

const KEY_NAMES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  cmd: 'super',
  meta: 'super',
  super: 'super',
  return: 'Return',
  enter: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  insert: 'Insert',
}

const PUNCTUATION: Record<string, string> = {
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  '`': 'grave',
}

/** A key combination ("ctrl+shift+t", "escape") in xdotool's names; an error for anything else. */
export function xdotoolKey(combo: string) {
  const parts = combo
    .trim()
    .split('+')
    .map((part) => part.trim())
  if (!parts.length || parts.some((part) => !part))
    throw new Error(`Not a key: ${JSON.stringify(combo)}`)
  return parts
    .map((part) => {
      const known = KEY_NAMES[part.toLowerCase()]
      if (known) return known
      if (/^f([1-9]|1[0-2])$/i.test(part)) return part.toUpperCase()
      if (/^[A-Za-z0-9]$/.test(part)) return part.toLowerCase()
      const punctuation = PUNCTUATION[part]
      if (punctuation) return punctuation
      throw new Error(
        `Not a key: ${JSON.stringify(part)}. Use a letter, a digit, f1 to f12 or one of: ${Object.keys(KEY_NAMES).join(', ')}`,
      )
    })
    .join('+')
}

/** computer_snapshot and computer_act, on a Mac or a cloud computer's desktop; computer_key on one. */
export function desktopTools(desktop: Desktop): Record<string, Tool> {
  const { where, keyboard } = desktop
  const about = ABOUT[where]
  const call = async (
    args: string[],
    options: { stdin?: string; signal?: AbortSignal | undefined },
  ) => {
    await desktop.ready?.(options.signal)
    return desktopCall(desktop.exec, args, {
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
  /**
   * Text into a field that takes none through accessibility: the field focused by a click on its
   * ref, then typed with the keyboard (what was in it selected first, for set_value).
   */
  const typeWithKeyboard = async (input: ActInput, signal?: AbortSignal) => {
    await call(['click', input.ref], { signal })
    if (input.action === 'set_value') await keyboard!.key('ctrl+a', signal)
    await keyboard!.type(input.text ?? '', signal)
  }
  const tools: Record<string, Tool> = {
    computer_snapshot: tool({
      description:
        "An app's interface as a tree, an element a line: its role, name, value, states, its ref " +
        '(@s…:e…) and what it can do {click, …}. Act on a ref with computer_act: it works through ' +
        "the app's accessibility, without moving the pointer or taking the keyboard focus, so it is the " +
        'first way to use an app. ' +
        (where === 'mac'
          ? 'Use computer_screenshot and computer_click for what the tree does not show (a canvas, a ' +
            'game, an element without a ref). '
          : 'A dialog or a bubble is a window of its own, or a sheet (surface: sheet). ') +
        'Refs belong to their snapshot: take a new one after the interface changed, and to check that ' +
        'an action worked. A big app: skeleton first, then root on the region you need. ' +
        about,
      inputSchema: jsonSchema<SnapshotInput>({
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description:
              where === 'mac'
                ? 'The app, by the name computer_apps lists (default: the one in front)'
                : `The app (default ${CLOUD_APP}, your browser)`,
          },
          window: {
            type: 'string',
            description:
              where === 'mac'
                ? 'A window id, when the app has several (an error lists them)'
                : 'A window id from otherWindows (default: the window in front)',
          },
          root: { type: 'string', description: 'A ref: only what is inside that element' },
          skeleton: {
            type: 'boolean',
            description: 'A shallow overview, each container with how many elements it holds',
          },
          surface: {
            type: 'string',
            enum: [...SURFACES[where]],
            description: 'What to read (default window): an open menu, a sheet or an alert',
          },
          all: {
            type: 'boolean',
            description: 'Every element, not only those you can act on (default false)',
          },
          hidden: {
            type: 'boolean',
            description: 'Include elements hidden from view (default false)',
          },
          bounds: {
            type: 'boolean',
            description: "Each element's frame <x,y width×height> in screen points (default false)",
          },
          maxDepth: { type: 'number', description: 'Levels of the tree (default 10)' },
        },
      }),
      execute: async (input, { abortSignal }) => {
        // On a cloud computer, with no window named: one of the browser's (pickWindow).
        let others: { id: string; title: string }[] = []
        let read = input
        if (where === 'cloud' && !input.window && !input.app) {
          const windows = (await call(['list-windows', '--app', CLOUD_APP], {
            signal: abortSignal,
          }).catch((error: unknown) => explain(error, where))) as unknown
          const picked = pickWindow(Array.isArray(windows) ? (windows as WindowInfo[]) : [])
          if (picked.chosen) read = { ...input, window: picked.chosen }
          others = picked.others
        }
        const data = await call(snapshotArgs(read, where), { signal: abortSignal }).catch(
          (error: unknown) => explain(error, where),
        )
        const tree = renderTree(data.tree as DesktopNode | undefined, {
          ...(input.hidden ? { hidden: true } : {}),
        })
        return {
          app: data.app,
          snapshot: data.snapshot_id,
          ...(data.complete === false
            ? {
                complete: false,
                incomplete: 'The app was still loading: take another snapshot to see all of it.',
              }
            : {}),
          tree: tree.text,
          ...(tree.left
            ? {
                cut: `${tree.left} more elements are not shown: narrow it with skeleton: true, then root on the region you need.`,
              }
            : {}),
          ...(tree.hidden ? { hiddenLeftOut: tree.hidden } : {}),
          ...(read.window && !input.window ? { window: read.window } : {}),
          ...(others.length ? { otherWindows: others } : {}),
        }
      },
    }),
    computer_act: tool({
      description:
        'Act on an element by its ref from computer_snapshot: click, type or set_value (text), select ' +
        '(option), toggle, check, expand, scroll… Through accessibility: the pointer and the keyboard ' +
        'focus stay where they are. ' +
        (where === 'mac'
          ? 'When an element does not take an action that way (a web page field often won’t take type), ' +
            "headed: true uses the real keyboard and mouse instead, taking the person's pointer and focus " +
            'for a moment. '
          : 'A field that takes no text that way (Chrome’s own fields) gets it from the keyboard: your ' +
            'browser window comes to the front of the desktop for it. ') +
        'Then take a new snapshot to check it worked. ' +
        about,
      inputSchema: jsonSchema<ActInput>({
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The ref, as the snapshot gives it: @s…:e…' },
          action: { type: 'string', enum: [...(where === 'mac' ? ACTIONS : CLOUD_ACTIONS)] },
          text: { type: 'string', description: 'For type and set_value' },
          option: { type: 'string', description: 'For select: the option to pick' },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'For scroll (default down)',
          },
          amount: { type: 'number', description: 'For scroll: how far (default 3)' },
          ...(where === 'mac'
            ? {
                headed: {
                  type: 'boolean',
                  description:
                    'Real keyboard and mouse input instead of accessibility (default false)',
                },
              }
            : {}),
        },
        required: ['ref', 'action'],
      }),
      execute: async (input, { abortSignal }) => {
        // A cloud computer's desktop takes no headed input from agent-desktop (see the top).
        const act = where === 'cloud' ? { ...input, headed: false } : input
        const { args, stdin } = actArgs(act)
        let data: Record<string, unknown>
        try {
          data = await call(args, {
            ...(stdin !== undefined ? { stdin } : {}),
            signal: abortSignal,
          })
        } catch (error) {
          if (
            keyboard &&
            (act.action === 'type' || act.action === 'set_value') &&
            error instanceof DesktopError &&
            NO_SEMANTIC_TEXT.has(error.code)
          ) {
            await typeWithKeyboard(act, abortSignal).catch((error: unknown) =>
              explain(error, where),
            )
            return {
              action: input.action,
              delivery: 'typed_with_keyboard',
              check: 'Take a new snapshot to check the field (a password field shows no value).',
            }
          }
          explain(error, where)
        }
        const disposition = data.disposition as { delivery?: string } | undefined
        const surfaces = surfacesOf(data)
        return {
          action: input.action,
          ...(disposition?.delivery ? { delivery: disposition.delivery } : {}),
          ...(surfaces.length ? { open: surfaces } : {}),
        }
      },
    }),
  }
  if (keyboard)
    tools.computer_key = tool({
      description:
        'Press a key or a shortcut in your browser window, not in a web page: "escape", "return", ' +
        '"tab", "ctrl+l", "ctrl+shift+t". Your browser window comes to the front of the desktop for it, ' +
        'and the key goes to what has the focus in it. ' +
        about,
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'A key, with modifiers (ctrl, shift, alt) joined with +',
          },
        },
        required: ['key'],
      }),
      execute: async (input, { abortSignal }) => {
        const combo = xdotoolKey(input.key)
        await desktop.ready?.(abortSignal)
        await keyboard.key(combo, abortSignal)
        return { pressed: input.key }
      },
    })
  return tools
}

/** How long one agent-desktop command may run through Brigade Computer Use, in seconds. */
const MAC_TIMEOUT = 90

/**
 * agent-desktop on a member's Mac, run by Brigade Computer Use (its `run`), so that it gets the
 * helper's Accessibility: a command the runner starts itself belongs to Brigade.app, which has
 * none. Its answer goes to a file rather than through the helper's output, which keeps only the
 * last 100 KB; text to type goes through a file too, never on its command line.
 */
export function macDesktopExec(
  computer: ComputerUse,
  binary: AgentDesktopBinary | undefined,
): DesktopExec {
  return async (args, options = {}) => {
    if (!binary)
      throw new Error(
        'agent-desktop is missing from this runner: use computer_screenshot and computer_click meanwhile.',
      )
    const dir = await mkdtemp(join(tmpdir(), 'brigade-desktop-'))
    try {
      // Interrupted already: the helper's request would wait for an abort that came before it.
      if (options.signal?.aborted) throw new Error('aborted')
      const out = join(dir, 'out.json')
      const err = join(dir, 'err.txt')
      let input = '/dev/null'
      if (options.stdin !== undefined) {
        input = join(dir, 'in.txt')
        await writeFile(input, options.stdin, { mode: 0o600 })
      }
      const command =
        `exec ${[binary.path, ...args].map(shellQuote).join(' ')} ` +
        `<${shellQuote(input)} >${shellQuote(out)} 2>${shellQuote(err)}`
      // An interrupted turn stops the command too, rather than leaving it to its timeout.
      const cancel = () => void computer.request('cancel', {}).catch(() => undefined)
      options.signal?.addEventListener('abort', cancel, { once: true })
      let result: { output?: string; timedOut?: boolean } = {}
      try {
        result = (await computer.request(
          'run',
          {
            command,
            cwd: computer.workDir,
            env: {
              ...computer.env(),
              ...(binary.macosHelper
                ? { AGENT_DESKTOP_MACOS_HELPER_PATH: binary.macosHelper }
                : {}),
            },
            timeout: MAC_TIMEOUT,
          },
          options.signal,
          { wait: (MAC_TIMEOUT + 30) * 1000, once: true },
        )) as typeof result
      } catch (error) {
        if (error instanceof ComputerUseError && error.code === 'unknown_method')
          throw new Error(
            'The Brigade Computer Use on this Mac is too old for this: ask the person to update ' +
              'Brigade.app (Check for Updates… in its menu), or use computer_screenshot and computer_click.',
          )
        throw error
      } finally {
        options.signal?.removeEventListener('abort', cancel)
      }
      const stdout = await readFile(out, 'utf8').catch(() => '')
      if (stdout.trim()) return stdout
      const stderr = (await readFile(err, 'utf8').catch(() => '')).trim()
      throw new Error(
        `agent-desktop gave no answer${result.timedOut ? ` in ${MAC_TIMEOUT} seconds` : ''}` +
          `${stderr || result.output ? `: ${(stderr || result.output || '').slice(-1000)}` : ''}`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
