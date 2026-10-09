'use client'
import Link from 'next/link'
import { useState, type InputHTMLAttributes } from 'react'
import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { credentialHint } from '@/components/mention'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api, useApi, type Credential, type CredentialKind, type CredentialUse } from '@/lib/api'

const KINDS: { kind: CredentialKind; label: string; hint: string }[] = [
  {
    kind: 'website',
    label: 'Website login',
    hint: 'Typed into the teammate’s browser on this site only. The teammate never sees the password.',
  },
  {
    kind: 'database',
    label: 'Database',
    hint: 'Given to the thread as a private env file (DATABASE_URL, PG* for Postgres).',
  },
  {
    kind: 'api_key',
    label: 'API key',
    hint: 'Given to the thread as a private env file (API_KEY, API_URL).',
  },
  {
    kind: 'other',
    label: 'Other secret',
    hint: 'Given to the thread as a private env file (SECRET).',
  },
]

const SECRET_LABEL: Record<CredentialKind, string> = {
  website: 'Password',
  database: 'Password',
  api_key: 'API key',
  other: 'Secret',
}
const SECRET_FIELD = {
  website: 'password',
  database: 'password',
  api_key: 'apiKey',
  other: 'value',
}

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

/** Add a credential, or edit one: its secret is only replaced when typed again. */
function CredentialForm({
  credential,
  onCancel,
  onSaved,
}: {
  credential?: Credential
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? 'website')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const d = credential?.details ?? {}
  const prefix = credential ? `cred-${credential.id}` : 'cred'

  async function save(form: FormData) {
    setError(undefined)
    setBusy(true)
    const text = (key: string) => String(form.get(key) ?? '').trim() || undefined
    const port = text('port')
    const details = {
      ...(text('url') ? { url: text('url') } : {}),
      ...(text('username') ? { username: text('username') } : {}),
      ...(kind === 'database'
        ? {
            engine: text('engine'),
            ...(text('host') ? { host: text('host') } : {}),
            ...(port ? { port: Number(port) } : {}),
            ...(text('database') ? { database: text('database') } : {}),
          }
        : {}),
      ...(text('notes') ? { notes: text('notes') } : {}),
    }
    // Not trimmed: a secret is kept exactly as typed.
    const value = String(form.get('secret') ?? '')
    const secret = value ? { secret: { [SECRET_FIELD[kind]]: value } } : {}
    try {
      if (credential)
        await api(`/credentials/${credential.id}`, {
          method: 'PATCH',
          body: { name: text('name'), details, ...secret },
        })
      else await api('/credentials', { body: { kind, name: text('name'), details, ...secret } })
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const field = (key: string, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      <Input
        id={`${prefix}-${key}`}
        name={key}
        {...props}
        className={cn(credential && 'bg-card', props.className)}
      />
    </div>
  )

  return (
    <form
      action={save}
      className={cn(
        'flex flex-col gap-4',
        credential ? 'rounded-lg border bg-muted/50 p-4' : 'rounded-xl border bg-card p-5 shadow-sm',
      )}
    >
      {!credential && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-kind`}>Kind</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as CredentialKind)}>
            <SelectTrigger id={`${prefix}-kind`} className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.kind} value={k.kind}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {KINDS.find((k) => k.kind === kind)!.hint}
          </p>
        </div>
      )}
      {field('name', 'Name', {
        required: true,
        maxLength: 80,
        defaultValue: credential?.name,
        placeholder:
          kind === 'website'
            ? 'GitHub (support bot)'
            : kind === 'database'
              ? 'Production database (read-only)'
              : 'OpenWeather API',
      })}
      {kind === 'website' &&
        field('url', 'Sign-in page', {
          type: 'url',
          required: true,
          defaultValue: d.url,
          placeholder: 'https://github.com/login',
        })}
      {kind === 'api_key' &&
        field('url', 'API base URL (optional)', {
          type: 'url',
          defaultValue: d.url,
          placeholder: 'https://api.example.com',
        })}
      {kind === 'database' && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${prefix}-engine`}>Engine</Label>
            <Select name="engine" defaultValue={d.engine ?? 'postgres'}>
              <SelectTrigger
                id={`${prefix}-engine`}
                className={cn('w-full sm:w-72', credential && 'bg-card')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
                <SelectItem value="mysql">MySQL</SelectItem>
                <SelectItem value="mongodb">MongoDB</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-start gap-3">
            <div className="col-span-3">
              {field('host', 'Host', {
                required: true,
                defaultValue: d.host,
                placeholder: 'db.internal',
              })}
            </div>
            <div>
              {field('port', 'Port', {
                type: 'number',
                min: 1,
                max: 65535,
                defaultValue: d.port,
                placeholder: '5432',
              })}
            </div>
          </div>
          {field('database', 'Database', { defaultValue: d.database, placeholder: 'app' })}
        </>
      )}
      {(kind === 'website' || kind === 'database') &&
        field('username', kind === 'website' ? 'Username or email' : 'User', {
          defaultValue: d.username,
          autoComplete: 'off',
        })}
      {field('secret', SECRET_LABEL[kind], {
        type: 'password',
        autoComplete: 'new-password',
        required: !credential,
        placeholder: credential ? 'Leave empty to keep the saved one' : '',
      })}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-notes`}>Notes for teammates (optional)</Label>
        <Textarea
          id={`${prefix}-notes`}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={d.notes}
          placeholder="Read-only replica. Ask before running anything heavy."
          className={cn(credential && 'bg-card')}
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy}>{credential ? 'Save' : 'Add to vault'}</Button>
      </div>
    </form>
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
