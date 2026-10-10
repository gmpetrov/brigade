'use client'
import type { AttachmentInfo, TaskColumn, TaskPriority, UploadTicket } from '@brigade/contracts'
import { useCallback, useEffect, useState } from 'react'
import { API_URL } from './config'

export type { AttachmentInfo } from '@brigade/contracts'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Call the Brigade API with the session cookie. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API_URL}/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'include',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? null : JSON.stringify(init.body),
  })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new ApiError((body as { error?: string }).error ?? response.statusText, response.status)
  return body as T
}

/**
 * Send a request body with XMLHttpRequest, as fetch reports no upload
 * progress. Resolves to the parsed JSON body, if any.
 */
function send(
  request: { method: string; url: string; headers?: Record<string, string>; credentials: boolean },
  body: XMLHttpRequestBodyInit,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(request.method, request.url)
    xhr.withCredentials = request.credentials
    for (const [name, value] of Object.entries(request.headers ?? {}))
      xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      const json = (() => {
        try {
          return xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : undefined
        } catch {
          return undefined
        }
      })()
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json)
      const error = (json as { error?: string } | undefined)?.error
      reject(new ApiError(error ?? `Upload failed (${xhr.status || xhr.statusText})`, xhr.status))
    }
    xhr.onerror = () => reject(new ApiError('Upload failed: storage is unreachable', 0))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(body)
  })
}

/**
 * Upload one file for a message, reporting progress from 0 to 1. Sent with
 * the message by its id. Straight to the bucket when the API hands out a
 * signed URL; otherwise through the API.
 */
export async function uploadAttachment(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AttachmentInfo> {
  const ticket = await api<UploadTicket>('/attachments/uploads', {
    body: { name: file.name || 'file', size: file.size, contentType: file.type },
  })
  if (!ticket.direct) {
    const form = new FormData()
    form.append('file', file)
    const url = `${API_URL}/api/attachments`
    return (await send(
      { method: 'POST', url, credentials: true },
      form,
      onProgress,
      signal,
    )) as AttachmentInfo
  }
  const id = ticket.attachment.id
  try {
    await send(
      { method: ticket.method, url: ticket.url, headers: ticket.headers, credentials: false },
      file,
      onProgress,
      signal,
    )
    return await api<AttachmentInfo>(`/attachments/${id}/complete`, { body: {} })
  } catch (error) {
    // The half-done upload goes; the API would sweep it later anyway.
    void api(`/attachments/${id}`, { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

/** A file given to a thread (or an unsent upload), as itself; `download` saves it instead. */
export const attachmentUrl = (id: string, download = false) =>
  `${API_URL}/api/attachments/${id}/content${download ? '?download' : ''}`

/** An image in a teammate's working folder for a thread, for an `<img>`. */
export const threadImageUrl = (threadId: string, path: string, teammateId?: string) =>
  `${API_URL}/api/threads/${threadId}/image?${new URLSearchParams({ path, ...(teammateId ? { teammateId } : {}) })}`

/** Fetch on mount; `reload` refetches. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<ApiError | undefined>()
  const reload = useCallback(async () => {
    if (!path) return
    try {
      setData(await api<T>(path))
      setError(undefined)
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 0))
    }
  }, [path])
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, reload, setData }
}

// Response shapes used by the dashboard.
export type Me = {
  user: { id: string; name: string; email: string }
  organizations: { id: string; name: string; slug: string; role: string }[]
  activeOrganizationId: string | null
  role: 'owner' | 'admin' | 'member' | null
  workspaces: { id: string; name: string }[]
  activeWorkspaceId: string | null
  memberId: string | null
}

export type Teammate = {
  id: string
  name: string
  instructions: string
  harness: 'claude_code' | 'codex'
  model: string | null
  permissionPolicy: { connectorWrites?: 'allow' | 'ask' | 'deny' } | null
  caps: Caps | null
  libraryAccess?: 'read' | 'read_write'
  createdAt: string
}

export type Caps = {
  threadsPerDay?: number | null
  computerHoursPerDay?: number | null
  writeCallsPerConnectionPerDay?: number | null
}

export type Computer = {
  id: string
  name: string
  kind: 'cloud' | 'member_machine'
  status: 'pending' | 'creating' | 'starting' | 'running' | 'stopped' | 'error' | 'destroyed'
  online: boolean
  runner: { version: string | null; platform: string | null; lastSeenAt: string | null } | null
}

export type ThreadSummary = {
  id: string
  title: string
  status: string
  updatedAt: string
  /** The teammate that started the thread. */
  teammate: { id: string; name: string }
  /** Everyone in it, the starting teammate first. */
  teammates: { teammate: { id: string; name: string } }[]
  startedBy: { id: string; user: { name: string } }
}

export type Thread = Omit<ThreadSummary, 'teammates'> & {
  startedByMemberId: string
  othersMayPrompt: boolean
  /** Adds nothing to workspace memory; its summary is the starter's only. */
  private: boolean
  controlledByMemberId: string | null
  mayPrompt: boolean
  lastSeq: number
  teammate: { id: string; name: string; harness: string; model: string | null }
  teammates: {
    joinedAt: string
    lastTurnAt: string
    teammate: { id: string; name: string; harness: string; model: string | null }
  }[]
  computer: { id: string; name: string; kind: string }
  account: { id: string; label: string; status: string } | null
  origin: 'member' | 'trigger' | 'schedule'
  trigger: { id: string; label: string; event: string } | null
  schedule: { id: string; title: string } | null
  tickets: Pick<Ticket, 'id' | 'type' | 'title' | 'payload' | 'createdAt'>[]
  /** Every file given to the thread, oldest first. */
  attachments: AttachmentInfo[]
  /** The task this thread works on, if it is one. */
  task: { id: string; title: string; completedAt: string | null } | null
}

export type { TaskColumn, TaskPriority } from '@brigade/contracts'

/** A teammate prompted with the same instructions on a cron schedule, on its owner's accounts. */
export type Schedule = {
  id: string
  teammateId: string
  title: string
  instructions: string
  cron: string
  timezone: string
  ownerMemberId: string
  createdByTeammateId: string | null
  pausedAt: string | null
  nextRunAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  teammate: { id: string; name: string; harness: Teammate['harness']; archivedAt: string | null }
  owner: { id: string; user: { name: string } }
  createdByTeammate: { id: string; name: string } | null
  /** Its latest thread. */
  lastRun: { id: string; status: string; createdAt: string } | null
}

/** A task on the board, with its thread if it has started. */
export type Task = {
  id: string
  title: string
  description: string
  priority: TaskPriority
  column: TaskColumn
  teammate: { id: string; name: string; harness: Teammate['harness'] }
  createdBy: { id: string; user: { name: string } }
  createdByMemberId: string
  summary: string | null
  deliverables: { label: string; url: string }[]
  completedAt: string | null
  createdAt: string
  updatedAt: string
  thread: {
    id: string
    status: string
    updatedAt: string
    computerId: string
    startedByMemberId: string
    openTickets: number
  } | null
}

export type TaskDetail = Task & {
  pullRequests: {
    id: string
    repository: string
    number: number
    title: string
    state: string
    headRef: string
  }[]
}

export type AccountLogin = {
  state: 'starting' | 'open_url' | 'verifying' | 'done' | 'failed'
  url?: string
  userCode?: string
  flow?: 'paste' | 'device'
  error?: string
}

export type Account = {
  id: string
  provider: 'claude_code' | 'codex'
  source: 'machine' | 'brigade'
  label: string
  email: string | null
  plan: string | null
  status: 'signing_in' | 'unverified' | 'ready' | 'needs_sign_in' | 'exhausted'
  exhaustedUntil: string | null
  isDefault: boolean
  lastUsage: { window: string; utilization: number; resetsAt: string | null }[] | null
  computer: { id: string; name: string; kind: 'cloud' | 'member_machine' }
  login: AccountLogin | null
}

export type ComputersResponse = { cloudAvailable: boolean; computers: Computer[] }

/** Computers a thread can run on: online machines, and the workspace computer unless broken (it resumes on demand). */
export const usableComputers = (data: ComputersResponse | undefined) =>
  (data?.computers ?? []).filter(
    (c) =>
      c.online || (c.kind === 'cloud' && ['running', 'stopped', 'starting'].includes(c.status)),
  )

export const computerName = (c: { kind: string; name: string }) =>
  c.kind === 'cloud' ? 'Workspace computer' : c.name

export type Connection = {
  id: string
  /** webhook: a custom app that posts events to Brigade. Inbound only. */
  kind: 'gmail' | 'google_calendar' | 'stripe' | 'github' | 'webhook'
  label: string
  externalAccount: string | null
  /** Where a person manages the account at the provider, e.g. a GitHub installation's settings. */
  externalUrl: string | null
  status: 'active' | 'needs_reauth' | 'removed'
  createdAt: string
  grants: { teammateId: string; scope: 'read' | 'read_write' }[]
  /** How its triggers' events reach Brigade: one per watched resource. */
  subscriptions: {
    resource: string
    mode: 'push' | 'poll'
    error: string | null
    expiresAt: string | null
  }[]
}
export type ConnectionsResponse = {
  available: Record<Connection['kind'], boolean>
  connections: Connection[]
}

export type { CredentialKind, CredentialSummary as Credential } from '@brigade/contracts'
export type {
  LibraryFile,
  MemoryFile,
  MemoryOverview,
  SearchHit,
  ThreadSummary as MemorySummary,
} from '@brigade/contracts'

export type CredentialUse = {
  id: string
  at: string
  teammate: string
  sessionId: string | null
  use: 'browser' | 'env' | null
  /** mention: a member mentioned it in the thread. approval: a person approved the request. */
  via: 'mention' | 'approval'
}

/** An event on a connection that starts a thread for a teammate. */
export type Trigger = {
  id: string
  label: string
  connectionId: string
  /** The catalog id, e.g. payment_received. */
  event: string
  options: Record<string, string>
  /** Custom apps only. */
  verification: 'hmac' | 'none' | null
  url: string | null
  hasSecret: boolean
  createdAt: string
  teammate: { id: string; name: string }
}

export type TriggerOption = {
  name: string
  label: string
  placeholder?: string
  help?: string
  required?: boolean
}
export type TriggerKind = {
  event: string
  label: string
  description: string
  options: TriggerOption[]
}
export type TriggerCatalog = {
  catalog: Record<Connection['kind'], TriggerKind[]>
  /** push: the vendor sends events. poll: Brigade asks every minute. */
  kinds: Record<Connection['kind'], { delivery: 'push' | 'poll'; unavailable: string | null }>
}

export type TimelineState = 'working' | 'waiting' | 'blocked' | 'done'
export type Timeline = {
  from: string
  to: string
  totals: Record<TimelineState, number>
  threads: {
    id: string
    title: string
    status: string
    origin: 'member' | 'trigger' | 'schedule'
    segments: { state: TimelineState; from: string; to: string; note?: string }[]
    doneAt?: string
  }[]
  usage: {
    since: string
    caps: Caps | null
    threads: number
    computerHours: number
    writeCalls: Record<string, number>
  }
}

export type RunLogEntry = {
  at: string
  source: 'event' | 'call' | 'ticket' | 'audit'
  type: string
  seq?: number
  data: Record<string, unknown>
}
export type RunLog = { entries: RunLogEntry[]; members: Record<string, string> }

export type ConnectionCall = {
  id: string
  sessionId: string
  operation: string
  write: boolean
  target: string
  result: string
  error: string | null
  ticketId: string | null
  createdAt: string
  teammate: { name: string }
}

export type Ticket = {
  id: string
  type: 'approval' | 'question' | 'request' | 'sign_in' | 'cap' | 'usage_limit'
  status: 'open' | 'approved' | 'denied' | 'resolved'
  title: string
  payload: {
    connection?: string
    connectionId?: string
    operation?: string
    target?: string
    input?: unknown
    resetsAt?: string
    reason?: string
    source?: 'harness'
    toolName?: string
    pending?: { text: string; memberId: string | null }
    cap?: keyof Caps
    limit?: number
    used?: number
    accountId?: string
    memberId?: string
    triggerId?: string
    pullRequest?: { repository: string; number: number }
  }
  createdAt: string
  resolvedAt: string | null
  session: {
    id: string
    title: string
    origin: 'member' | 'trigger' | 'schedule'
    startedByMemberId: string
    teammate: { id: string; name: string }
  } | null
}

export const isAdmin = (me: Me) => me.role === 'owner' || me.role === 'admin'

/** Whether an open ticket waits on this member: the same rules that give them actions below. */
export function waitsOn(t: Ticket, me: Me) {
  if (t.status !== 'open') return false
  const admin = isAdmin(me)
  const starter = t.session?.startedByMemberId === me.memberId
  if (t.type === 'approval') return admin || starter
  if (t.type === 'cap') return admin
  if ((t.type === 'question' || t.type === 'request') && t.payload.source === 'harness')
    return admin || starter
  return admin || (t.payload.memberId ? t.payload.memberId === me.memberId : starter)
}

export const harnessLabel = (harness: string) => (harness === 'codex' ? 'Codex' : 'Claude')

/**
 * Show the workspace computer's desktop in a new tab, optionally with a window
 * of a teammate's browser opened on it first. The tab opens at once, in the
 * click, so popup blockers allow it; its address follows when ready.
 */
export async function openDesktop(
  computerId: string,
  browser?: { teammateId: string; url?: string },
) {
  const tab = window.open('about:blank', '_blank')
  if (tab) tab.opener = null
  try {
    if (browser)
      await api(`/teammates/${browser.teammateId}/browser`, {
        body: browser.url ? { url: browser.url } : {},
      })
    const { url } = await api<{ url: string }>(`/computers/${computerId}/desktop`, {
      method: 'POST',
    })
    if (tab) tab.location.href = url
    else window.location.href = url
  } catch (error) {
    tab?.close()
    throw error
  }
}

export type {
  CheckRun,
  DiffFile,
  MergeMethod,
  PullRequestDetail,
  PullRequestList,
  PullRequestSummary,
  PullRequestTracking,
  ReviewStatus,
  TeammateReview,
} from '@brigade/contracts'

/** The dashboard's page for a pull request. */
export const pullHref = (repository: string, number: number) => `/app/pulls/${repository}/${number}`
/** A repository the workspace's GitHub connections reach. */
export type RepositoryOption = { repository: string; private: boolean; connection: string }
