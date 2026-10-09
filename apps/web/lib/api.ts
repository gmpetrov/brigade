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
  createdAt: string
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
  teammate: { id: string; name: string }
  startedBy: { id: string; user: { name: string } }
}

export type Thread = ThreadSummary & {
  startedByMemberId: string
  othersMayPrompt: boolean
  controlledByMemberId: string | null
  mayPrompt: boolean
  lastSeq: number
  teammate: { id: string; name: string; harness: string; model: string | null }
  computer: { id: string; name: string; kind: string }
  account: { id: string; label: string; status: string } | null
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
  kind: 'gmail' | 'google_calendar' | 'stripe'
  label: string
  externalAccount: string | null
  status: 'active' | 'needs_reauth' | 'removed'
  createdAt: string
  grants: { teammateId: string; scope: 'read' | 'read_write' }[]
}
export type ConnectionsResponse = { available: { gmail: boolean }; connections: Connection[] }

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
    operation?: string
    target?: string
    input?: unknown
    resetsAt?: string
  }
  createdAt: string
  resolvedAt: string | null
  session: {
    id: string
    title: string
    startedByMemberId: string
    teammate: { name: string }
  } | null
}

export const harnessLabel = (harness: string) => (harness === 'codex' ? 'Codex' : 'Claude')
