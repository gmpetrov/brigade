'use client'
import {
  folderAccessFor,
  type FolderAccess,
  type FolderRule,
  type LibraryAccess,
} from '@brigade/contracts'
import { KeyRound, Library } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { levelOf, LEVEL_LABEL } from '@/components/credential-access'
import { useDashboard } from '@/components/dashboard'
import { credentialHint } from '@/components/mention'
import { ProviderTile } from '@/components/provider-logo'
import {
  api,
  isAdmin,
  useApi,
  type LibraryFolder,
  type ConnectionsResponse,
  type CredentialGrantLevel,
  type CredentialWithGrants,
  type Teammate,
  type Trigger,
  type TriggerCatalog,
} from '@/lib/api'

type Scope = 'none' | 'read' | 'read_write'

/**
 * Which connections and credentials a teammate may use, whether its changes
 * wait for a person, and what outside starts threads for it.
 */
export function TeammateAccess({
  teammate,
  editable,
  onPolicyChange,
}: {
  teammate: Teammate
  editable: boolean
  onPolicyChange: () => void
}) {
  const connections = useApi<ConnectionsResponse>('/connections')
  const grants = useApi<{ connectionId: string; scope: Exclude<Scope, 'none'> }[]>(
    `/teammates/${teammate.id}/grants`,
  )
  const credentials = useApi<CredentialWithGrants[]>('/credentials')
  const { me } = useDashboard()
  const hooks = useApi<Trigger[]>('/triggers')
  const catalog = useApi<TriggerCatalog>('/triggers/catalog')
  const folders = useApi<LibraryFolder[]>('/library/folders')
  const [error, setError] = useState<string>()
  const policy = (teammate.permissionPolicy?.connectorWrites ?? 'allow') as 'allow' | 'ask' | 'deny'

  async function setGrant(connectionId: string, scope: Scope) {
    setError(undefined)
    try {
      await api(`/teammates/${teammate.id}/grants`, {
        method: 'PUT',
        body: { connectionId, scope },
      })
      await grants.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function setCredential(credentialId: string, level: CredentialGrantLevel) {
    setError(undefined)
    try {
      await api(`/credentials/${credentialId}/grants`, {
        method: 'PUT',
        body: { teammateId: teammate.id, level },
      })
      await credentials.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function setLibrary(libraryAccess: string) {
    setError(undefined)
    try {
      await api(`/teammates/${teammate.id}`, { method: 'PATCH', body: { libraryAccess } })
      onPolicyChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function setPolicy(connectorWrites: string) {
    await api(`/teammates/${teammate.id}`, {
      method: 'PATCH',
      body: { permissionPolicy: { ...teammate.permissionPolicy, connectorWrites } },
    })
    onPolicyChange()
  }

  const all = connections.data?.connections ?? []
  // A custom app only sends events: nothing to grant.
  const list = all.filter((c) => c.kind !== 'webhook')
  const triggers = (hooks.data ?? []).filter((w) => w.teammate.id === teammate.id)
  return (
    <Card className="gap-0 overflow-hidden pb-0">
      <CardHeader className="pb-4">
        <CardTitle>
          <h2 className="text-base font-bold">Access</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="flex flex-wrap items-center gap-3 border-t px-6 py-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
          >
            <Library className="size-4" />
          </span>
          <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
            <Link href="/app/library" className="truncate text-sm font-semibold hover:underline">
              Document library
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              Search, memory and the shared files
            </span>
          </span>
          <Select
            value={teammate.libraryAccess ?? 'read'}
            disabled={!editable}
            onValueChange={(v) => void setLibrary(v)}
          >
            <SelectTrigger size="sm" aria-label="Document library access">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">Read only</SelectItem>
              <SelectItem value="read_write">Read and write</SelectItem>
            </SelectContent>
          </Select>
          <FolderExceptions
            teammate={{ id: teammate.id, library: teammate.libraryAccess ?? 'read' }}
            folders={folders.data}
          />
        </div>
        {list.length === 0 ? (
          <p className="border-t px-6 py-3 text-sm text-muted-foreground">
            No connections in this workspace yet.{' '}
            <Link href="/app/connections" className="font-medium text-primary hover:underline">
              Add one
            </Link>
            .
          </p>
        ) : (
          list.map((c) => {
            const scope: Scope = grants.data?.find((g) => g.connectionId === c.id)?.scope ?? 'none'
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-3 border-t px-6 py-3">
                <ProviderTile kind={c.kind} small />
                <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
                  <span className="truncate text-sm font-semibold">{c.label}</span>
                  {c.externalAccount && (
                    <span className="truncate text-xs text-muted-foreground">
                      {c.externalAccount}
                    </span>
                  )}
                </span>
                <Select
                  value={scope}
                  disabled={!editable}
                  onValueChange={(v) => void setGrant(c.id, v as Scope)}
                >
                  <SelectTrigger size="sm" aria-label={`${c.label} access`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No access</SelectItem>
                    <SelectItem value="read">Read only</SelectItem>
                    <SelectItem value="read_write">Read and write</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )
          })
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t px-6 pt-4 pb-2">
          <h3 className="flex-1 text-sm font-bold">Secrets</h3>
          <Link href="/app/security" className="text-xs font-medium text-primary hover:underline">
            Every teammate&apos;s access
          </Link>
        </div>
        {credentials.data?.length === 0 ? (
          <p className="px-6 pb-3 text-sm text-muted-foreground">
            No secrets yet.{' '}
            <Link href="/app/vault" className="font-medium text-primary hover:underline">
              Add a secret
            </Link>
            .
          </p>
        ) : (
          (credentials.data ?? []).map((c) => {
            const level = levelOf(c, teammate.id)
            // Its creator or an admin decides who uses it.
            const mayChange = isAdmin(me) || c.createdByMemberId === me.memberId
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-3 border-t px-6 py-3">
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
                >
                  <KeyRound className="size-4" />
                </span>
                <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
                  <span className="truncate text-sm font-semibold">{c.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {c.access === 'all' ? 'Shared with all teammates' : credentialHint(c)}
                  </span>
                </span>
                <Select
                  value={level}
                  disabled={!mayChange}
                  onValueChange={(v) => void setCredential(c.id, v as CredentialGrantLevel)}
                >
                  <SelectTrigger size="sm" aria-label={`${c.name} access`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {c.access === 'selected' && (
                      <SelectItem value="none">{LEVEL_LABEL.none}</SelectItem>
                    )}
                    <SelectItem value="use">{LEVEL_LABEL.use}</SelectItem>
                    <SelectItem value="without_asking">{LEVEL_LABEL.without_asking}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )
          })
        )}
        <div className="flex flex-wrap items-center gap-3 border-t bg-secondary px-6 py-3.5">
          <span className="flex-[1_1_16rem] text-sm font-semibold">
            Acts without approval{' '}
            <span className="font-normal text-muted-foreground">(sending, editing, deleting)</span>
          </span>
          <Select value={policy} disabled={!editable} onValueChange={(v) => void setPolicy(v)}>
            <SelectTrigger size="sm" aria-label="Acts without approval" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">Allow</SelectItem>
              <SelectItem value="ask">Ask a person first</SelectItem>
              <SelectItem value="deny">Never</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-0.5 border-t px-6 pt-4 pb-2">
          <h3 className="text-sm font-bold">Starts threads from</h3>
          <p className="text-xs text-muted-foreground">
            Triggers on connections. Their threads follow the policy above.
          </p>
        </div>
        {triggers.length === 0 ? (
          <p className="px-6 pb-3 text-sm text-muted-foreground">
            Nothing yet.{' '}
            <Link href="/app/connections" className="font-medium text-primary hover:underline">
              Add a trigger
            </Link>{' '}
            on a connection.
          </p>
        ) : (
          triggers.map((w) => {
            const c = all.find((c) => c.id === w.connectionId)
            const from = c ? (c.externalAccount ?? c.label) : 'a removed connection'
            const kind = c && catalog.data?.catalog[c.kind]?.find((k) => k.event === w.event)
            return (
              <div key={w.id} className="flex flex-wrap items-center gap-3 border-t px-6 py-3">
                {c && <ProviderTile kind={c.kind} small />}
                <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
                  <span className="truncate text-sm font-semibold">{w.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {c?.kind === 'webhook'
                      ? `Events posted by ${from}`
                      : `${kind?.label ?? w.event} on ${from}${Object.values(w.options).length ? ` · ${Object.values(w.options).join(' · ')}` : ''}`}
                  </span>
                </span>
                <Link
                  href="/app/connections"
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Manage
                </Link>
              </div>
            )
          })
        )}
        {error && <p className="border-t px-6 py-3 text-sm text-destructive-text">{error}</p>}
      </CardContent>
    </Card>
  )
}

const FOLDER_ACCESS: Record<FolderAccess, string> = {
  none: 'no access',
  read: 'read only',
  read_write: 'read and write',
}

/** The library folders where this teammate's access differs from the folder above. */
function FolderExceptions({
  teammate,
  folders,
}: {
  teammate: { id: string; library: LibraryAccess }
  folders: LibraryFolder[] | undefined
}) {
  const rules: FolderRule[] = (folders ?? [])
    .filter((f) => f.restricted || f.grants.length > 0)
    .map((f) => ({
      path: f.path,
      restricted: f.restricted,
      grants: Object.fromEntries(f.grants.map((g) => [g.teammateId, g.access])),
    }))
  const differ = rules
    .map((r) => {
      const access = folderAccessFor(r.path, teammate, rules)
      const parent = r.path.includes('/')
        ? folderAccessFor(r.path.slice(0, r.path.lastIndexOf('/')), teammate, rules)
        : teammate.library
      return { path: r.path, access, differs: access !== parent }
    })
    .filter((r) => r.differs)
    .sort((a, b) => a.path.localeCompare(b.path))
  if (differ.length === 0) return null
  return (
    <p className="basis-full pl-11 text-xs text-muted-foreground">
      Except{' '}
      {differ.map((r, i) => (
        <span key={r.path}>
          {i > 0 && ', '}
          <Link
            href={`/app/library?folder=${encodeURIComponent(r.path)}`}
            className="font-mono text-foreground hover:underline"
          >
            {r.path}/
          </Link>{' '}
          ({FOLDER_ACCESS[r.access]})
        </span>
      ))}
      .
    </p>
  )
}
