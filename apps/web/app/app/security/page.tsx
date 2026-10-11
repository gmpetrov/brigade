'use client'
// Security: who may reach what across every teammate, what deserves a look,
// and (for admins) what happened. Connections and the Vault stay where things
// are added; this page governs them.
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { AccessMatrix, type MatrixActions } from '@/components/security-matrix'
import { SecurityActivity } from '@/components/security-activity'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, useApi, type AccessOverview } from '@/lib/api'

const DAY = 24 * 60 * 60 * 1000

type Notice = { key: string; text: React.ReactNode; href?: string; action?: string }

/** Things worth a look: wide access, autonomy, and what nobody uses or owns any more. */
function attention(data: AccessOverview): Notice[] {
  const notices: Notice[] = []
  const name = (id: string) => data.teammates.find((t) => t.id === id)?.name ?? 'a teammate'
  const list = (names: string[]) =>
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`

  const unchecked = data.teammates.filter(
    (t) =>
      t.connectorWrites === 'allow' &&
      data.connectionGrants.some((g) => g.teammateId === t.id && g.scope === 'read_write'),
  )
  if (unchecked.length)
    notices.push({
      key: 'writes',
      text: `${list(unchecked.map((t) => t.name))} can send, edit and delete through connections without asking a person.`,
    })

  const free = data.credentials.filter((c) => c.grants.some((g) => g.withoutAsking))
  for (const c of free)
    notices.push({
      key: `free-${c.id}`,
      text: `${list(c.grants.filter((g) => g.withoutAsking).map((g) => name(g.teammateId)))} can use ${c.name} without asking${
        c.access === 'all' ? ', and it is shared with every teammate' : ''
      }.`,
    })

  const orphaned = data.credentials.filter((c) => !c.creatorActive)
  if (orphaned.length)
    notices.push({
      key: 'orphaned',
      text: `${list(orphaned.map((c) => c.name))} ${orphaned.length === 1 ? 'was' : 'were'} added by someone who left; only admins can change ${orphaned.length === 1 ? 'it' : 'them'} now.`,
      href: '/app/vault',
      action: 'Review',
    })

  const stale = data.credentials.filter(
    (c) =>
      Date.now() - new Date(c.createdAt).getTime() > 90 * DAY &&
      (!c.lastUsedAt || Date.now() - new Date(c.lastUsedAt).getTime() > 90 * DAY),
  )
  if (stale.length)
    notices.push({
      key: 'stale',
      text: `No teammate used ${list(stale.map((c) => c.name))} in 90 days. Delete what is no longer needed.`,
      href: '/app/vault',
      action: 'Review',
    })

  const reauth = data.connections.filter((c) => c.status === 'needs_reauth')
  if (reauth.length)
    notices.push({
      key: 'reauth',
      text: `${list(reauth.map((c) => c.externalAccount ?? c.label))} ${reauth.length === 1 ? 'needs' : 'need'} to be connected again.`,
      href: '/app/connections',
      action: 'Reconnect',
    })
  return notices
}

export default function SecurityPage() {
  const { me, reloadTeammates } = useDashboard()
  const admin = isAdmin(me)
  const access = useApi<AccessOverview>('/security/access')
  const [tab, setTab] = useState('access')
  const [error, setError] = useState<string>()

  /** Change something, then show the matrix as the API now has it. */
  async function change(request: () => Promise<unknown>, teammatesChanged = false) {
    setError(undefined)
    try {
      await request()
    } catch (e) {
      setError((e as Error).message)
    }
    await access.reload()
    if (teammatesChanged) await reloadTeammates()
  }

  const actions: MatrixActions = {
    setConnection: (teammateId, connectionId, scope) =>
      void change(() =>
        api(`/teammates/${teammateId}/grants`, { method: 'PUT', body: { connectionId, scope } }),
      ),
    setCredential: (credentialId, teammateId, level) =>
      void change(() =>
        api(`/credentials/${credentialId}/grants`, { method: 'PUT', body: { teammateId, level } }),
      ),
    shareCredential: (credentialId, all) => {
      const credential = access.data?.credentials.find((c) => c.id === credentialId)
      if (!credential) return
      void change(() =>
        api(`/credentials/${credentialId}/access`, {
          method: 'PUT',
          body: { access: all ? 'all' : 'selected', grants: credential.grants },
        }),
      )
    },
    setLibrary: (teammateId, libraryAccess) =>
      void change(
        () => api(`/teammates/${teammateId}`, { method: 'PATCH', body: { libraryAccess } }),
        true,
      ),
    setWrites: (teammateId, connectorWrites) =>
      void change(
        () =>
          api(`/teammates/${teammateId}`, {
            method: 'PATCH',
            body: { permissionPolicy: { connectorWrites } },
          }),
        true,
      ),
  }

  const notices = access.data ? attention(access.data) : []

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Security</h1>
        <p className="max-w-prose text-muted-foreground">
          What each teammate can reach and do on its own.{' '}
          {admin
            ? 'Change any cell here, or on a teammate’s page.'
            : 'Admins change connections and policies; you can change the secrets you added.'}
        </p>
      </header>

      {access.data &&
        (notices.length ? (
          <section
            aria-labelledby="attention"
            className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 p-4"
          >
            <h2 id="attention" className="flex items-center gap-2 text-sm font-bold">
              <AlertTriangle className="size-4 text-warning" aria-hidden />
              Worth a look
            </h2>
            <ul className="flex flex-col gap-1.5">
              {notices.map((n) => (
                <li key={n.key} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="min-w-0 flex-[1_1_20rem]">{n.text}</span>
                  {n.href && (
                    <Link
                      href={n.href}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {n.action}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-success" aria-hidden />
            Nothing needs attention: no teammate acts on its own, and every secret has an owner and
            gets used.
          </p>
        ))}

      {error && <p className="text-sm text-destructive-text">{error}</p>}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="access">Access</TabsTrigger>
          {admin && <TabsTrigger value="activity">Activity</TabsTrigger>}
        </TabsList>
        <TabsContent value="access" className="pt-2">
          {access.error ? (
            <p className="text-sm text-destructive-text">{access.error.message}</p>
          ) : !access.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <AccessMatrix
              data={access.data}
              admin={admin}
              memberId={me.memberId}
              actions={actions}
            />
          )}
        </TabsContent>
        {admin && (
          <TabsContent value="activity" className="pt-2">
            <SecurityActivity teammates={access.data?.teammates ?? []} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
