'use client'
// Security: who may reach what across every teammate and (for admins) what
// happened. Connections and the Vault stay where things are added; this page
// governs them.
import { useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { AccessMatrix, type MatrixActions } from '@/components/security-matrix'
import { SecurityActivity } from '@/components/security-activity'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, useApi, type AccessOverview } from '@/lib/api'

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
