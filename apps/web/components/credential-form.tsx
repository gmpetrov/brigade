'use client'
// Adding a credential to the vault, or editing one: on the Vault page, and in a
// thread when a teammate asks for one it lacks. The secret goes straight to the
// vault and is never shown again.
import { useId, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import type { Ask } from '@brigade/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api, type Credential, type CredentialKind } from '@/lib/api'

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

/** What a teammate knows of a credential it asks for: it fills in a new one's form. */
export type CredentialDraft = NonNullable<Extract<Ask, { type: 'access' }>['credential']>

/** Add a credential, or edit one: its secret is only replaced when typed again. */
export function CredentialForm({
  credential,
  draft,
  inline = Boolean(credential),
  submitLabel,
  onCancel,
  onSaved,
}: {
  credential?: Credential
  /** A new credential's starting values. */
  draft?: CredentialDraft
  /** Inside another card: a quieter frame. */
  inline?: boolean
  submitLabel?: string
  onCancel?: () => void
  onSaved: (saved: Credential) => Promise<void> | void
}) {
  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? draft?.kind ?? 'website')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const d = credential?.details ?? { url: draft?.url, username: draft?.username }
  const prefix = useId()

  async function save(event: FormEvent<HTMLFormElement>) {
    // Not a form action: React would clear what was typed when saving fails.
    event.preventDefault()
    const form = new FormData(event.currentTarget)
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
      const saved = credential
        ? await api<Credential>(`/credentials/${credential.id}`, {
            method: 'PATCH',
            body: { name: text('name'), details, ...secret },
          })
        : await api<Credential>('/credentials', {
            body: { kind, name: text('name'), details, ...secret },
          })
      await onSaved(saved)
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
        className={cn(inline && 'bg-card', props.className)}
      />
    </div>
  )

  return (
    <form
      onSubmit={(event) => void save(event)}
      className={cn(
        'flex flex-col gap-4',
        inline ? 'rounded-lg border bg-muted/50 p-4' : 'rounded-xl border bg-card p-5 shadow-sm',
      )}
    >
      {!credential && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-kind`}>Kind</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as CredentialKind)}>
            <SelectTrigger
              id={`${prefix}-kind`}
              className={cn('w-full sm:w-72', inline && 'bg-card')}
            >
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
        defaultValue: credential?.name ?? draft?.name,
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
            <Select name="engine" defaultValue={credential?.details.engine ?? 'postgres'}>
              <SelectTrigger
                id={`${prefix}-engine`}
                className={cn('w-full sm:w-72', inline && 'bg-card')}
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
                defaultValue: credential?.details.host,
                placeholder: 'db.internal',
              })}
            </div>
            <div>
              {field('port', 'Port', {
                type: 'number',
                min: 1,
                max: 65535,
                defaultValue: credential?.details.port,
                placeholder: '5432',
              })}
            </div>
          </div>
          {field('database', 'Database', {
            defaultValue: credential?.details.database,
            placeholder: 'app',
          })}
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
      {/* A new one saved from a thread stays short; notes can be added in the Vault. */}
      {(credential || !inline) && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-notes`}>Notes for teammates (optional)</Label>
          <Textarea
            id={`${prefix}-notes`}
            name="notes"
            rows={2}
            maxLength={2000}
            defaultValue={credential?.details.notes}
            placeholder="Read-only replica. Ask before running anything heavy."
            className={cn(inline && 'bg-card')}
          />
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button disabled={busy}>{submitLabel ?? (credential ? 'Save' : 'Add to vault')}</Button>
      </div>
    </form>
  )
}
