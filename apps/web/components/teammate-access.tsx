'use client'
import { Library } from 'lucide-react'
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
import { ProviderTile } from '@/components/provider-logo'
import {
  api,
  useApi,
  type ConnectionsResponse,
  type Teammate,
  type Trigger,
  type TriggerCatalog,
} from '@/lib/api'

type Scope = 'none' | 'read' | 'read_write'

/**
 * Which connections a teammate may use, whether its changes wait for a person,
 * and what outside starts threads for it.
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
  const hooks = useApi<Trigger[]>('/triggers')
  const catalog = useApi<TriggerCatalog>('/triggers/catalog')
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
        <div className="flex flex-wrap items-center gap-3 border-t bg-secondary px-6 py-3.5">
          <span className="flex-[1_1_16rem] text-sm font-semibold">
            Changes through connections{' '}
            <span className="font-normal text-muted-foreground">(sending, editing, deleting)</span>
          </span>
          <Select value={policy} disabled={!editable} onValueChange={(v) => void setPolicy(v)}>
            <SelectTrigger
              size="sm"
              aria-label="Changes through connections"
              className="bg-background"
            >
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
