// The dashboard's side of a tool's bridge (docs/tools.md): what its page asks
// for, checked and made with the person's session. The page's origin is opaque,
// so a message counts only when it comes from the tool's own frame; what it
// says is checked here again, as anything a teammate's script sends could be.
import {
  formatMention,
  TOOL_MESSAGE_MAX,
  ToolBridgeRequest,
  type ToolAccount,
  type ToolCallResult,
  type ToolView,
} from '@brigade/contracts'
import { ApiError } from '@/lib/api'

/** An answer to the page. */
export type ToolAnswer =
  | { source: 'brigade-host'; id: string | number; ok: true; result: unknown }
  | { source: 'brigade-host'; id: string | number; ok: false; error: string; code?: string }

/** Something the person confirms in the dashboard's own dialog before it goes. */
export type ToolConfirm =
  | { kind: 'write'; app: string; account: string; operation: string; input: unknown }
  | { kind: 'message'; thread: string; text: string }

export type ToolHost = {
  view: ToolView
  /** The thread messages go to: the one beside, else the one that saved the tool, when the person may write in it. */
  threadId: string | undefined
  me: { memberId: string | null; name: string }
  api: <T>(path: string, body: unknown) => Promise<T>
  confirm: (what: ToolConfirm) => Promise<boolean>
}

/** A message the page sent, if it is a call of the bridge. */
export function bridgeRequest(data: unknown): ToolBridgeRequest | null {
  const parsed = ToolBridgeRequest.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** The attached account a page names, by its connection id or its App's kind: a usable one first. */
export function accountFor(accounts: ToolAccount[], ref: unknown): ToolAccount | undefined {
  if (typeof ref !== 'string' || !ref) return undefined
  const byId = accounts.find((a) => a.connectionId === ref)
  if (byId) return byId
  const ofKind = accounts.filter((a) => a.kind === ref)
  return ofKind.find((a) => a.usable && !a.changed) ?? ofKind[0]
}

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown) => v === true

class Refused extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** Why an account cannot be called now, or null. */
function unusable(account: ToolAccount | undefined, ref: unknown) {
  if (!account)
    return new Refused(`No account ${String(ref)} is attached to this tool`, 'no_account')
  if (account.changed)
    return new Refused(
      'The tool changed since this account was attached: allow it again from Accounts',
      'tool_changed',
    )
  if (!account.usable)
    return new Refused(
      `${account.account} is a personal account: only its owner can use it here`,
      'not_usable',
    )
  return null
}

/** What the page asked for, made: its result, or throws why not. */
async function perform(host: ToolHost, request: ToolBridgeRequest): Promise<unknown> {
  const { view, api } = host
  const path = view.folder
  const p = request.params
  switch (request.method) {
    case 'me':
      return { memberId: host.me.memberId, name: host.me.name }
    case 'files.list': {
      const folder = text(p.folder)
      if (!folder) throw new Refused('Name a library folder')
      return api('/tools/files', { path, folder })
    }
    case 'state.get':
    case 'state.list':
    case 'state.set':
    case 'state.delete': {
      const op = request.method.slice('state.'.length)
      const version = typeof p.version === 'number' ? p.version : undefined
      const prefix = text(p.prefix)
      const body = {
        op,
        path,
        shared: bool(p.shared),
        ...(op !== 'list' ? { key: text(p.key) ?? '' } : {}),
        ...(op === 'list' && prefix ? { prefix } : {}),
        ...(op === 'set' ? { value: p.value ?? null } : {}),
        ...(version !== undefined && (op === 'set' || op === 'delete') ? { version } : {}),
      }
      return (await api<{ result: unknown }>('/tools/state', body)).result
    }
    case 'apps.list':
      return view.accounts.map((a) => ({
        connectionId: a.connectionId,
        kind: a.kind,
        app: a.app,
        account: a.account,
        access: a.access,
        usable: a.usable,
        changed: a.changed,
      }))
    case 'apps.operations': {
      const account = accountFor(view.accounts, p.account)
      const why = unusable(account, p.account)
      if (why) throw why
      return api('/tools/operations', { path, connectionId: account!.connectionId })
    }
    case 'apps.call': {
      const account = accountFor(view.accounts, p.account)
      const why = unusable(account, p.account)
      if (why) throw why
      const operation = text(p.operation)
      if (!operation) throw new Refused('Name the operation to call')
      const call = { path, connectionId: account!.connectionId, operation, input: p.input ?? {} }
      let result: ToolCallResult
      try {
        result = await api<ToolCallResult>('/tools/call', call)
      } catch (error) {
        // A write: the person confirms it here first, then it goes again, confirmed.
        if (!(error instanceof ApiError) || error.status !== 428) throw error
        const yes = await host.confirm({
          kind: 'write',
          app: account!.app,
          account: account!.account,
          operation,
          input: call.input,
        })
        if (!yes) throw new Refused('The person did not allow it', 'declined')
        result = await api<ToolCallResult>('/tools/call', { ...call, confirmed: true })
      }
      if (!result.ok) throw new Refused(result.error, 'app_error')
      return result.output
    }
    case 'thread.send': {
      const message = text(p.text)?.trim()
      if (!message) throw new Refused('Write something to send')
      if (message.length > TOOL_MESSAGE_MAX)
        throw new Refused(`A message takes at most ${TOOL_MESSAGE_MAX} characters`)
      if (!host.threadId) throw new Refused('This tool has no thread you can write in', 'no_thread')
      const yes = await host.confirm({
        kind: 'message',
        thread: view.thread?.title ?? 'its thread',
        text: message,
      })
      if (!yes) throw new Refused('The person did not send it', 'declined')
      await api(`/threads/${host.threadId}/messages`, { text: toolMessage(view, message) })
      return { sent: true }
    }
  }
}

/** A message from a tool, as the thread reads it: said to come from the tool, by its mention. */
export const toolMessage = (view: Pick<ToolView, 'folder' | 'toolId'>, message: string) =>
  `From the tool ${formatMention({ kind: 'document', id: view.toolId, label: view.folder })}:\n\n${message}`

/** Answer one call of the page. */
export async function answer(host: ToolHost, request: ToolBridgeRequest): Promise<ToolAnswer> {
  try {
    const result = await perform(host, request)
    return { source: 'brigade-host', id: request.id, ok: true, result: result ?? null }
  } catch (error) {
    const code =
      error instanceof Refused
        ? error.code
        : error instanceof ApiError
          ? ((error.body as { code?: unknown } | undefined)?.code as string | undefined)
          : undefined
    return {
      source: 'brigade-host',
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
}
