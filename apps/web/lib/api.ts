'use client'
import { useCallback, useEffect, useState } from 'react'
import { API_URL } from './config'

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
  origin: 'member' | 'webhook'
  webhook: { id: string; label: string } | null
  tickets: Pick<Ticket, 'id' | 'type' | 'title' | 'payload' | 'createdAt'>[]
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
  kind: 'gmail' | 'google_calendar' | 'stripe' | 'github'
  label: string
  externalAccount: string | null
  /** Where a person manages the account at the provider, e.g. a GitHub installation's settings. */
  externalUrl: string | null
  status: 'active' | 'needs_reauth' | 'removed'
  createdAt: string
  grants: { teammateId: string; scope: 'read' | 'read_write' }[]
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

export type Webhook = {
  id: string
  label: string
  connectionId: string
  verification: 'stripe' | 'hmac' | 'none'
  url: string
  hasSecret: boolean
  createdAt: string
  teammate: { id: string; name: string }
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
    origin: 'member' | 'webhook'
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
  type: 'approval' | 'question' | 'sign_in' | 'cap' | 'usage_limit'
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
    webhookId?: string
  }
  createdAt: string
  resolvedAt: string | null
  session: {
    id: string
    title: string
    origin: 'member' | 'webhook'
    startedByMemberId: string
    teammate: { id: string; name: string }
  } | null
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
