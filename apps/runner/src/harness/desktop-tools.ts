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
  desktopBatch,
  desktopCall,
  renderTree,
  type BatchEntry,
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

/** computer_act's input: one action, or steps done in order. */
export type ActToolInput = Partial<Omit<ActInput, 'headed'>> & {
  steps?: Omit<ActInput, 'headed'>[]
  headed?: boolean
  observe?: boolean
}

/** What an action on a ref takes, alone or as one of computer_act's steps. */
function stepProperties(where: 'mac' | 'cloud') {
  return {
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
  } as const
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
          String(scrollAmount(input.amount)),
        ],
      }
    default:
      return { args: [...headed, input.action.replace(/_/g, '-'), ref] }
  }
}

/** Actions that carry text: through stdin, one at a time, never in a batch's JSON. */
const TEXT_ACTIONS = new Set<Action>(['type', 'set_value'])

const scrollAmount = (amount?: number) => Math.min(Math.max(Math.round(amount ?? 3), 1), 50)

/** An action without text as a batch entry: the command's own field names. */
export function actEntry(input: ActInput): BatchEntry {
  const ref_id = input.ref
  switch (input.action) {
    case 'type':
    case 'set_value':
      throw new Error(`${input.action} carries text, which never goes in a batch`)
    case 'select':
      if (!input.option) throw new Error('option is required to select')
      return { command: 'select', args: { ref_id, value: input.option } }
    case 'scroll':
      return {
        command: 'scroll',
        args: { ref_id, direction: input.direction ?? 'down', amount: scrollAmount(input.amount) },
      }
    default:
      return { command: input.action.replace(/_/g, '-'), args: { ref_id } }
  }
}

/** A snapshot as a batch entry, as snapshotArgs gives it on the command line. */
export function snapshotEntry(input: SnapshotInput, where: Desktop['where']): BatchEntry {
  const app = input.app ?? (where === 'cloud' && !input.window ? CLOUD_APP : undefined)
  return {
    command: 'snapshot',
    args: {
      ...(app ? { app } : {}),
      ...(input.window ? { window_id: input.window } : {}),
      interactive_only: !input.all,
      compact: true,
      ...(input.root ? { root: input.root } : {}),
      ...(input.skeleton ? { skeleton: true } : {}),
      ...(input.bounds ? { include_bounds: true } : {}),
      ...(input.surface && input.surface !== 'window' ? { surface: input.surface } : {}),
      ...(input.maxDepth
        ? { max_depth: Math.min(Math.max(Math.round(input.maxDepth), 1), 50) }
        : {}),
      timeout_ms: SNAPSHOT_TIMEOUT_MS,
    },
  }
}

/** Chromium and Electron apps settle slowly: agent-desktop's 3 seconds read them thin. */
const SNAPSHOT_TIMEOUT_MS = 8000
/** How long an interface gets to show what an action did, before it is read again. */
export const SETTLE_MS = 300
/** The most steps one computer_act takes (agent-desktop's batch takes 64 commands). */
export const STEPS_MAX = 30

/** The snapshot a ref belongs to: @<snapshot id>:e<n>. */
const snapshotOf = (ref: string) => /^@([^:]+):/.exec(ref)?.[1]

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
    '--timeout-ms',
    String(SNAPSHOT_TIMEOUT_MS),
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
  const batch = async (
    entries: BatchEntry[],
    options: { headed?: boolean; signal?: AbortSignal | undefined },
  ) => {
    await desktop.ready?.(options.signal)
    return desktopBatch(desktop.exec, entries, {
      ...(options.headed ? { headed: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
  /**
   * What each snapshot of this turn read (its app, window, surface), by its id: an action on one
   * of its refs reads the same again, so it comes back with what it did and the new refs.
   */
  const reads = new Map<string, SnapshotInput>()
  /** A snapshot's answer as the teammate reads it, remembered for the actions on its refs. */
  const present = (
    data: Record<string, unknown>,
    read: SnapshotInput,
    extra: { hidden?: boolean; named?: boolean } = {},
  ) => {
    const tree = renderTree(data.tree as DesktopNode | undefined, {
      ...(extra.hidden ? { hidden: true } : {}),
      // Rooted on a region: all of it, as asked (up to the size limit).
      ...(read.root ? { children: Number.POSITIVE_INFINITY } : {}),
    })
    if (typeof data.snapshot_id === 'string') reads.set(data.snapshot_id, read)
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
      ...(read.window && !extra.named ? { window: read.window } : {}),
    }
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
  /** What an action did, as agent-desktop answered it. */
  const outcome = (action: Action, data: Record<string, unknown>) => {
    const disposition = data.disposition as { delivery?: string } | undefined
    const surfaces = surfacesOf(data)
    return {
      action,
      ...(disposition?.delivery ? { delivery: disposition.delivery } : {}),
      ...(surfaces.length ? { open: surfaces } : {}),
    }
  }
  /** One action on its own command line: text through stdin, typed with the keyboard where it must. */
  const single = async (act: ActInput, signal?: AbortSignal) => {
    const { args, stdin } = actArgs(act)
    try {
      return outcome(
        act.action,
        await call(args, { ...(stdin !== undefined ? { stdin } : {}), signal }),
      )
    } catch (error) {
      if (
        keyboard &&
        TEXT_ACTIONS.has(act.action) &&
        error instanceof DesktopError &&
        NO_SEMANTIC_TEXT.has(error.code)
      ) {
        await typeWithKeyboard(act, signal).catch((error: unknown) => explain(error, where))
        return {
          action: act.action,
          delivery: 'typed_with_keyboard',
          check: 'Take a new snapshot to check the field (a password field shows no value).',
        }
      }
      explain(error, where)
    }
  }
  /** After an action: the read its ref came from again, or the menu, sheet or alert it opened. */
  const readAfter = (read: SnapshotInput, opened: { type?: unknown; window?: string }[]) => {
    const surface = opened.find(
      (s) =>
        typeof s.type === 'string' &&
        s.type !== 'window' &&
        (SURFACES[where] as readonly string[]).includes(s.type),
    )
    // A skeleton was a map to find the region: what the action did shows in the region itself.
    const { skeleton: _skeleton, ...again } = read
    return surface
      ? {
          ...(read.app ? { app: read.app } : {}),
          ...(read.window ? { window: read.window } : {}),
          surface: surface.type as string,
        }
      : again
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
        'Long lists show their first items and a line for the rest, and elements scrolled out of view ' +
        'are counted in a line: root on a list to see all of it. Refs belong to their snapshot; ' +
        'computer_act gives the new ones after it acts. A big app: skeleton first, then root on the ' +
        'region you need. ' +
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
          root: {
            type: 'string',
            description: 'A ref: only what is inside that element, every item of its lists',
          },
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
            description: 'Include elements hidden or scrolled out of view (default false)',
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
        const { hidden: _hidden, ...remembered } = read
        return {
          ...present(data, remembered, {
            ...(input.hidden ? { hidden: true } : {}),
            named: !!input.window,
          }),
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
        'Several actions in a row (keys of a keypad, fields of a form): give them as steps, done in ' +
        'order in one call, stopping at the first that fails. It answers with what each did and, in ' +
        'after, the window as it is now with its new refs (or the menu, sheet or alert it opened): ' +
        'no snapshot is needed to check it, unless it says so. ' +
        about,
      inputSchema: jsonSchema<ActToolInput>({
        type: 'object',
        properties: {
          ...stepProperties(where),
          steps: {
            type: 'array',
            maxItems: STEPS_MAX,
            description: `Actions done in order, instead of ref and action (at most ${STEPS_MAX})`,
            items: {
              type: 'object',
              properties: stepProperties(where),
              required: ['ref', 'action'],
            },
          },
          ...(where === 'mac'
            ? {
                headed: {
                  type: 'boolean',
                  description:
                    'Real keyboard and mouse input instead of accessibility (default false)',
                },
              }
            : {}),
          observe: {
            type: 'boolean',
            description: 'Read the window again after acting, in after (default true)',
          },
        },
      }),
      execute: async (input, { abortSignal }) => {
        // A cloud computer's desktop takes no headed input from agent-desktop (see the top).
        const headed = where === 'mac' && !!input.headed
        const many = !!input.steps?.length
        const steps: ActInput[] = many
          ? input.steps!.map((step) => ({ ...step, headed }))
          : [
              {
                ref: input.ref!,
                action: input.action!,
                ...(input.text !== undefined ? { text: input.text } : {}),
                ...(input.option !== undefined ? { option: input.option } : {}),
                ...(input.direction ? { direction: input.direction } : {}),
                ...(input.amount !== undefined ? { amount: input.amount } : {}),
                headed,
              },
            ]
        if (steps.length > STEPS_MAX)
          throw new Error(`At most ${STEPS_MAX} steps in one call: split them.`)
        for (const step of steps) {
          if (!step.ref || !step.action)
            throw new Error('Give a ref and an action, or steps that each have them.')
          if (
            !(where === 'mac' ? ACTIONS : (CLOUD_ACTIONS as readonly Action[])).includes(
              step.action,
            )
          )
            throw new Error(`Not an action here: ${step.action}`)
          if (TEXT_ACTIONS.has(step.action) && step.text === undefined)
            throw new Error(`text is required to ${step.action}`)
          if (step.action === 'select' && !step.option)
            throw new Error('option is required to select')
        }
        const last = steps[steps.length - 1]!
        const remembered = snapshotOf(last.ref)
        const read = input.observe === false ? undefined : reads.get(remembered ?? '')

        const done: Record<string, unknown>[] = []
        let failed: { step: number; ref: string; error: string } | undefined
        let after: Record<string, unknown> | undefined
        let afterError: string | undefined
        const fail = (index: number, error: unknown) => {
          if (!many) explain(error, where)
          failed = {
            step: index,
            ref: steps[index]!.ref,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        const take = (data: Record<string, unknown>, from: SnapshotInput) => {
          after = present(data, from)
        }

        let i = 0
        while (i < steps.length && !failed) {
          // Text through stdin, one at a time; and one action with nothing to read after it.
          if (TEXT_ACTIONS.has(steps[i]!.action) || (!many && !read)) {
            try {
              done.push((await single(steps[i]!, abortSignal))!)
            } catch (error) {
              fail(i, error)
            }
            i++
            continue
          }
          // Actions without text, in a row: one batch, and the read after it when it ends them.
          let end = i
          while (end < steps.length && !TEXT_ACTIONS.has(steps[end]!.action)) end++
          const group = steps.slice(i, end)
          const readAlong = read && end === steps.length
          const entries = group.map(actEntry)
          if (readAlong)
            entries.push(
              { command: 'wait', args: { ms: SETTLE_MS } },
              snapshotEntry(readAfter(read, []), where),
            )
          let results
          try {
            results = await batch(entries, { headed, signal: abortSignal })
          } catch (error) {
            fail(i, error)
            break
          }
          for (let k = 0; k < group.length; k++) {
            const result = results[k]
            if (!result) {
              fail(i + k, new Error('agent-desktop did not get to it'))
              break
            }
            if (!result.ok) {
              fail(i + k, result.error)
              break
            }
            done.push(outcome(group[k]!.action, result.data))
          }
          if (readAlong && !failed) {
            const snapshot = results[results.length - 1]
            if (results.length === entries.length && snapshot?.ok)
              take(snapshot.data, readAfter(read, []))
            else if (snapshot && !snapshot.ok) afterError = snapshot.error.message
          }
          i = end
        }

        if (read) {
          // What the last action opened (a menu, a sheet), else the window when not read yet.
          const opened = (done[done.length - 1]?.open as { type?: unknown }[] | undefined) ?? []
          const surfaceRead = readAfter(read, opened)
          const again = surfaceRead.surface !== read.surface || (!after && !afterError)
          if (again) {
            try {
              const results = await batch(
                [{ command: 'wait', args: { ms: SETTLE_MS } }, snapshotEntry(surfaceRead, where)],
                { signal: abortSignal },
              )
              const snapshot = results[1]
              if (snapshot?.ok) {
                take(snapshot.data, surfaceRead)
                afterError = undefined
              } else if (snapshot) afterError = snapshot.error.message
            } catch (error) {
              afterError = error instanceof Error ? error.message : String(error)
            }
          }
          // What was read before may be gone (a region, a sheet the action closed, a window):
          // the app as a whole instead.
          if (!after && (read.root || read.surface || read.window)) {
            const {
              root: _root,
              surface: _surface,
              window: _window,
              ...whole
            } = readAfter(read, [])
            try {
              const results = await batch([snapshotEntry(whole, where)], { signal: abortSignal })
              if (results[0]?.ok) {
                take(results[0].data, whole)
                afterError = undefined
              }
            } catch {
              // Said below: the teammate takes a new snapshot.
            }
          }
        }
        const check =
          after || input.observe === false
            ? {}
            : {
                check: afterError
                  ? `Could not read the window after it (${afterError}): take a new snapshot to check it.`
                  : 'Take a new snapshot to check it worked.',
              }
        if (!many) return { ...check, ...done[0], ...(after ? { after } : {}) }
        return {
          done: done.length,
          of: steps.length,
          steps: done,
          ...(failed ? { failed } : {}),
          ...(after ? { after } : {}),
          ...check,
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
  find: (signal?: AbortSignal) => Promise<AgentDesktopBinary | undefined>,
): DesktopExec {
  return async (args, options = {}) => {
    const binary = await find(options.signal).catch((error: unknown) => {
      if (options.signal?.aborted) throw error
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: use computer_screenshot and computer_click meanwhile.`,
      )
    })
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
