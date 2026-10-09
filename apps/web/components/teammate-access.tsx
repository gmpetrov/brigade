'use client'
import Link from 'next/link'
import { useState } from 'react'
import { api, useApi, type ConnectionsResponse, type Teammate } from '@/lib/api'

type Scope = 'none' | 'read' | 'read_write'

/** Which connections a teammate may use, and whether its changes wait for a person. */
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
  const [error, setError] = useState<string>()
  const policy = (teammate.permissionPolicy?.connectorWrites ?? 'ask') as 'allow' | 'ask' | 'deny'

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

  async function setPolicy(connectorWrites: string) {
    await api(`/teammates/${teammate.id}`, {
      method: 'PATCH',
      body: { permissionPolicy: { ...teammate.permissionPolicy, connectorWrites } },
    })
    onPolicyChange()
  }

  const list = connections.data?.connections ?? []
  return (
    <div className="card stack">
      <h2>Access</h2>
      {list.length === 0 ? (
        <p className="hint">
          No connections in this workspace yet. <Link href="/app/connections">Add one</Link>.
        </p>
      ) : (
        list.map((c) => {
          const scope: Scope = grants.data?.find((g) => g.connectionId === c.id)?.scope ?? 'none'
          return (
            <div key={c.id} className="row">
              <span style={{ flex: 1 }}>
                {c.label} {c.externalAccount && <span className="hint">· {c.externalAccount}</span>}
              </span>
              <select
                value={scope}
                disabled={!editable}
                onChange={(e) => void setGrant(c.id, e.target.value as Scope)}
                style={{ width: 'auto' }}
              >
                <option value="none">No access</option>
                <option value="read">Read only</option>
                <option value="read_write">Read and write</option>
              </select>
            </div>
          )
        })
      )}
      <div className="row">
        <span style={{ flex: 1 }}>Changes through connections (sending, editing, deleting)</span>
        <select
          value={policy}
          disabled={!editable}
          onChange={(e) => void setPolicy(e.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="ask">Ask a person first</option>
          <option value="allow">Allow</option>
          <option value="deny">Never</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
