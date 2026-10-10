'use client'
import Link from 'next/link'
import { useState } from 'react'
import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import { CredentialForm } from '@/components/credential-form'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { credentialHint } from '@/components/mention'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { api, useApi, type Credential, type CredentialUse } from '@/lib/api'

export default function VaultPage() {
  const { me } = useDashboard()
  const credentials = useApi<Credential[]>('/credentials')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [uses, setUses] = useState<string>()
  const [error, setError] = useState<string>()
  const mayEdit = (c: Credential) => isAdmin(me) || c.createdByMemberId === me.memberId

  async function remove(c: Credential) {
    if (
      !confirm(
        `Delete ${c.name}? Its secret is erased from the vault; teammates can no longer use it.`,
      )
    )
      return
    setError(undefined)
    await api(`/credentials/${c.id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await credentials.reload()
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="text-3xl font-extrabold tracking-tight">Vault</h1>
            <p className="max-w-prose text-muted-foreground">
              Logins, databases and keys your teammates can use.
            </p>
          </div>
          {!adding && (
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add a credential
            </Button>
          )}
        </div>
        <div className="flex gap-3 rounded-lg bg-accent p-4 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-foreground" aria-hidden />
          <p>
            <span className="font-semibold text-accent-foreground">
              A secret is encrypted the moment you save it and is never shown again, here or to a
              teammate&apos;s model.
            </span>{' '}
            Type <code className="font-mono">@</code> and its name in a thread to let that
            thread&apos;s teammate use it; anywhere else, it has to ask and a person approves.
          </p>
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </header>

      {adding && (
        <CredentialForm
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await credentials.reload()
          }}
        />
      )}

      {credentials.data?.length === 0 && !adding ? (
        <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
          >
            <KeyRound className="size-5" />
          </span>
          <p className="font-semibold">Nothing in the vault yet.</p>
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add a credential
          </Button>
        </Card>
      ) : (credentials.data ?? []).length > 0 ? (
        <Card className="gap-0 divide-y py-0">
          {(credentials.data ?? []).map((c) => (
            <div key={c.id} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-4">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"
                >
                  <KeyRound className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                  <span className="font-semibold">{c.name}</span>
                  <span className="truncate text-sm text-muted-foreground">
                    {credentialHint(c)} · updated {timeAgo(c.updatedAt)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-expanded={uses === c.id}
                    onClick={() => setUses(uses === c.id ? undefined : c.id)}
                  >
                    {uses === c.id ? 'Hide uses' : 'Uses'}
                  </Button>
                  {mayEdit(c) && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-expanded={editing === c.id}
                        onClick={() => setEditing(editing === c.id ? undefined : c.id)}
                      >
                        Edit
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => void remove(c)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {editing === c.id && (
                <CredentialForm
                  credential={c}
                  onCancel={() => setEditing(undefined)}
                  onSaved={async () => {
                    setEditing(undefined)
                    await credentials.reload()
                  }}
                />
              )}
              {uses === c.id && <Uses credentialId={c.id} />}
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  )
}

function Uses({ credentialId }: { credentialId: string }) {
  const uses = useApi<CredentialUse[]>(`/credentials/${credentialId}/uses`)
  if (!uses.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (uses.data.length === 0)
    return <p className="text-sm text-muted-foreground">No teammate has used it yet.</p>
  return (
    <div className="rounded-lg border">
      <Table className="text-[13px]">
        <TableBody>
          {uses.data.map((u) => (
            <TableRow key={u.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {timeAgo(u.at)}
              </TableCell>
              <TableCell>{u.teammate}</TableCell>
              <TableCell>
                {u.use === 'browser' ? 'signed in with it' : 'loaded it as an env file'}
              </TableCell>
              <TableCell>
                <StatusBadge
                  status={u.via}
                  tone={u.via === 'mention' ? 'success' : 'warning'}
                  label={u.via === 'mention' ? 'mentioned' : 'approved'}
                />
              </TableCell>
              <TableCell>
                {u.sessionId && (
                  <Link
                    href={`/app/threads/${u.sessionId}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    thread
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
