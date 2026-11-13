// Tools (docs/tools.md): small web apps that live in the library. A tool is a
// folder named `<name>.tool` holding `tool.json` and `index.html`; teammates make
// them in threads, people open them in a sandboxed frame served from the same
// separate origin as designs. Unlike a design, a tool works: through a bridge to
// the dashboard around it, it lists library folders it declares, keeps state
// (the viewer's own, and shared), calls App accounts people attached to it, and
// sends messages to its thread. The dashboard asks the person before anything
// that changes something outside the tool.
import { z } from 'zod'
import { LibraryPath } from './library.js'

/** A tool's folder ends with this. */
export const TOOL_SUFFIX = '.tool'
/** Every tool has one, at the top of its folder. */
export const TOOL_MANIFEST = 'tool.json'
/** The page a tool opens on. */
export const TOOL_ENTRY = 'index.html'
/** Written by `save_tool` when the computer can render the tool: the gallery's picture. */
export const TOOL_THUMBNAIL = 'thumbnail.png'
/** Files a teammate saves in one tool. */
export const TOOL_FILES_MAX = 200

/** The tool folder a library path is in or is ("a/b.tool" for "a/b.tool/app.js"), if any. */
export function toolFolderOf(path: string): string | undefined {
  const parts = path.split('/')
  const at = parts.findIndex((p) => p.endsWith(TOOL_SUFFIX) && p.length > TOOL_SUFFIX.length)
  return at < 0 ? undefined : parts.slice(0, at + 1).join('/')
}

/** A tool's own name: its folder's, without the suffix. */
export const toolName = (folder: string) => folder.split('/').pop()!.slice(0, -TOOL_SUFFIX.length)

/** An App a tool asks for: its kind (`github`, `posthog`…) and whether it changes things there. */
export const ToolAppNeed = z.object({
  kind: z.string().trim().min(1).max(100),
  access: z.enum(['read', 'read_write']).default('read'),
  /** Why, in a line, shown to the person attaching an account. */
  why: z.string().max(300).optional(),
})
export type ToolAppNeed = z.infer<typeof ToolAppNeed>

/** An origin a tool's script may call directly (a public API): `https://api.example.com`. */
export const ToolHost = z
  .string()
  .max(200)
  .regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i, 'An https origin, without a path')

/** `tool.json`, written by the teammate. Lenient: a tool with a bad entry still opens. */
export const ToolManifest = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  /** Library folders the tool lists and reads (its own folder always). A bad one is left out. */
  reads: z
    .array(LibraryPath.nullable().catch(null))
    .max(20)
    .transform((list) => list.filter((p): p is string => p !== null))
    .optional(),
  /** Apps it calls; a person attaches an account of each. */
  apps: z
    .array(ToolAppNeed.nullable().catch(null))
    .max(10)
    .transform((list) => list.filter((a): a is ToolAppNeed => a !== null))
    .optional(),
  /** Public APIs its script calls directly, with no account of the workspace. */
  hosts: z
    .array(ToolHost.nullable().catch(null))
    .max(20)
    .transform((list) => list.filter((h): h is string => h !== null))
    .optional(),
})
export type ToolManifest = z.infer<typeof ToolManifest>

export const OpenToolView = z.object({ path: LibraryPath })

/** An App account attached to a tool, as its viewer sees it. */
export type ToolAccount = {
  connectionId: string
  kind: string
  /** The App's name, and the account (the GitHub organization, the Gmail address). */
  app: string
  account: string
  access: 'read' | 'read_write'
  /** Whether this viewer's calls may use it: a personal account works for its owner only. */
  usable: boolean
  /** The tool changed since it was attached: its calls wait until someone allows it again. */
  changed: boolean
  attachedBy: string | null
}

/** What the dashboard needs to show a tool. */
export type ToolView = {
  /** Its page on the sandbox origin, good for a few hours. */
  url: string
  folder: string
  manifest: ToolManifest | null
  /** The tool's id: its `index.html`'s. State and attached accounts stay with it when it moves. */
  toolId: string
  /** The thread that saved it last, when this member may see it: where its messages go. */
  thread: { id: string; title: string | null; mayPrompt: boolean } | null
  teammate: { id: string; name: string } | null
  accounts: ToolAccount[]
  /** Accounts of the workspace this member may attach, by the App the tool asks for. */
  attachable: { connectionId: string; kind: string; app: string; account: string }[]
  /** Whether this member may attach and detach accounts. */
  mayAttach: boolean
  expiresAt: string
}

export const AttachToolAccount = z.object({
  path: LibraryPath,
  connectionId: z.string().min(1).max(64),
  access: z.enum(['read', 'read_write']),
})

export const DetachToolAccount = z.object({
  path: LibraryPath,
  connectionId: z.string().min(1).max(64),
})

/** Allow a tool's accounts again after it changed: every account attached to it. */
export const ApproveToolChange = z.object({ path: LibraryPath })

/** Longest key a tool keeps state under, and largest value. */
export const TOOL_STATE_KEY_MAX = 200
export const TOOL_STATE_VALUE_MAX = 100_000
/** Keys a tool keeps per owner (each viewer's own, and the shared ones). */
export const TOOL_STATE_KEYS_MAX = 2000

const StateKey = z.string().min(1).max(TOOL_STATE_KEY_MAX)

/** State a tool keeps: `shared` for everyone who opens it, else the viewer's own. */
export const ToolStateRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), path: LibraryPath, shared: z.boolean(), key: StateKey }),
  z.object({
    op: z.literal('list'),
    path: LibraryPath,
    shared: z.boolean(),
    prefix: z.string().max(TOOL_STATE_KEY_MAX).optional(),
  }),
  z.object({
    op: z.literal('set'),
    path: LibraryPath,
    shared: z.boolean(),
    key: StateKey,
    value: z.unknown(),
    /** Write only over this version (0: only when the key is new); absent: whatever is there. */
    version: z.number().int().min(0).optional(),
  }),
  z.object({
    op: z.literal('delete'),
    path: LibraryPath,
    shared: z.boolean(),
    key: StateKey,
    version: z.number().int().min(1).optional(),
  }),
])
export type ToolStateRequest = z.infer<typeof ToolStateRequest>

/** A key's value and version (0 when it has none). */
export type ToolStateEntry = {
  key: string
  value: unknown
  version: number
  updatedAt: string | null
}

/** Library files a tool lists, from a folder it declares. */
export const ToolFilesRequest = z.object({
  path: LibraryPath,
  folder: LibraryPath,
})

export type ToolFile = {
  path: string
  name: string
  contentType: string
  size: number
  updatedAt: string
  /** Where its page can load it from, on the sandbox origin, while its address works. */
  url: string
}

/** An operation of an attached account, for the tool to call. */
export type ToolOperation = {
  name: string
  description: string
  write: boolean
  inputSchema: unknown
}

export const ToolOperationsRequest = z.object({
  path: LibraryPath,
  connectionId: z.string().min(1).max(64),
})

export const ToolCall = z.object({
  path: LibraryPath,
  connectionId: z.string().min(1).max(64),
  operation: z.string().min(1).max(200),
  input: z.unknown(),
  /**
   * The person confirmed this write in the dashboard's own dialog. Only the dashboard sets it: the
   * tool's page cannot reach the API, only ask the dashboard.
   */
  confirmed: z.boolean().optional(),
})
export type ToolCall = z.infer<typeof ToolCall>

/** The answer to a tool's call: what the App returned. */
export type ToolCallResult = { ok: true; output: unknown } | { ok: false; error: string }

/**
 * The bridge between a tool's page and the dashboard around it, by postMessage.
 * The page sends `{source: 'brigade-tool', id, method, params}`; the dashboard
 * answers `{source: 'brigade-host', id, ok, result | error}`.
 */
export const TOOL_METHODS = [
  'me',
  'files.list',
  'state.get',
  'state.list',
  'state.set',
  'state.delete',
  'apps.list',
  'apps.operations',
  'apps.call',
  'thread.send',
] as const
export type ToolMethod = (typeof TOOL_METHODS)[number]

export const ToolBridgeRequest = z.object({
  source: z.literal('brigade-tool'),
  id: z.union([z.string().max(100), z.number()]),
  method: z.enum(TOOL_METHODS),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type ToolBridgeRequest = z.infer<typeof ToolBridgeRequest>

/** A message a tool sends to its thread, at most this long. */
export const TOOL_MESSAGE_MAX = 20_000

// The script the sandbox host adds first to a tool's pages (docs/tools.md): it
// gives the page `window.brigade`, whose calls go to the dashboard around it by
// postMessage, since the page's origin is opaque and it reaches nothing of the
// API itself. The dashboard checks each call, makes it with the person's
// session, asks the person before any that changes something, and answers.
// Messages it sends carry `source: 'brigade-tool'`; it reads only answers from
// its parent with `source: 'brigade-host'`. Outside Brigade (the page opened on
// its own), every call fails saying so, and `brigade.inBrigade` is false.
//
// Plain JavaScript in a string: it runs in the tool's page, not here. The runner's check_design
// adds it too, so a tool renders there as when opened outside Brigade.

const SOURCE = String.raw`(function () {
  if (window.brigade) return
  var framed = window.parent !== window
  var pending = {}
  var next = 1
  var call = function (method, params) {
    if (!framed)
      return Promise.reject(new Error('Open this tool in Brigade to use brigade.' + method))
    return new Promise(function (resolve, reject) {
      var id = 'c' + next++
      pending[id] = { resolve: resolve, reject: reject }
      window.parent.postMessage(
        { source: 'brigade-tool', id: id, method: method, params: params || {} },
        '*',
      )
    })
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var m = event.data
    if (!m || m.source !== 'brigade-host' || typeof m.id !== 'string' || !pending[m.id]) return
    var p = pending[m.id]
    delete pending[m.id]
    if (m.ok) return p.resolve(m.result)
    var error = new Error(m.error || 'The call failed')
    if (m.code) error.code = m.code
    p.reject(error)
  })
  var state = function (shared) {
    return {
      get: function (key) {
        return call('state.get', { shared: shared, key: key })
      },
      list: function (prefix) {
        return call('state.list', { shared: shared, prefix: prefix })
      },
      set: function (key, value, options) {
        return call('state.set', {
          shared: shared,
          key: key,
          value: value,
          version: options && options.version,
        })
      },
      delete: function (key, options) {
        return call('state.delete', { shared: shared, key: key, version: options && options.version })
      },
    }
  }
  window.brigade = {
    inBrigade: framed,
    me: function () {
      return call('me')
    },
    files: {
      list: function (folder) {
        return call('files.list', { folder: folder })
      },
    },
    state: state(false),
    shared: state(true),
    apps: {
      list: function () {
        return call('apps.list')
      },
      operations: function (account) {
        return call('apps.operations', { account: account })
      },
      call: function (account, operation, input) {
        return call('apps.call', { account: account, operation: operation, input: input || {} })
      },
    },
    thread: {
      send: function (text) {
        return call('thread.send', { text: text })
      },
    },
  }
})()`

/** The bridge, as a script tag for the start of a tool page's head. */
export const toolBridgeScript = () => `<script data-brigade-tool-bridge>${SOURCE}</script>`
