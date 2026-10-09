'use client'
import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  api,
  harnessLabel,
  useApi,
  usableComputers,
  computerName,
  type Account,
  type AccountLogin,
  type ComputersResponse,
} from '@/lib/api'
import { useLive } from '@/lib/use-live'

const resetLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : ''

export default function Accounts() {
  const accounts = useApi<Account[]>('/accounts')
  const computers = useApi<ComputersResponse>('/computers')
  const [logins, setLogins] = useState<Record<string, AccountLogin>>({})
  const [error, setError] = useState<string>()

  useLive((message) => {
    if (message.type !== 'account.login') return
    setLogins((current) => ({ ...current, [message.accountId]: message }))
    if (message.state === 'done' || message.state === 'failed') void accounts.reload()
  })

  async function act(promise: Promise<unknown>) {
    setError(undefined)
    try {
      await promise
      await accounts.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function add(form: FormData) {
    await act(
      api('/accounts', {
        body: {
          computerId: String(form.get('computerId')),
          provider: String(form.get('provider')),
        },
      }),
    )
  }

  const online = usableComputers(computers.data)
  const byProvider = (provider: Account['provider']) =>
    (accounts.data ?? []).filter((a) => a.provider === provider)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight">Accounts</h1>
        <p className="max-w-prose text-muted-foreground">
          Your Claude and Codex subscriptions. Add several of each: when one runs out of usage,
          your threads continue on the next. Accounts are yours alone; nobody else&apos;s threads
          use them.
        </p>
        <div className="flex gap-3 rounded-lg bg-accent p-4 text-sm text-accent-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Brigade never sees your password or tokens: you sign in on the vendor&apos;s own page,
            and the login stays on the computer.
          </p>
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </header>

      {(['claude_code', 'codex'] as const).map((provider) => (
        <section
          key={provider}
          aria-labelledby={`accounts-${provider}`}
          className="flex flex-col gap-3"
        >
          <h2 id={`accounts-${provider}`} className="text-lg font-bold tracking-tight">
            {provider === 'codex' ? 'Codex' : 'Claude'}{' '}
            <span className="font-semibold text-muted-foreground">
              {byProvider(provider).length}
            </span>
          </h2>
          {byProvider(provider).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No {harnessLabel(provider)} accounts yet.
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {byProvider(provider).map((a) => (
                <AccountCard key={a.id} account={a} login={logins[a.id] ?? a.login} onAct={act} />
              ))}
            </div>
          )}
        </section>
      ))}

      <Card className="gap-4 border-dashed p-5 shadow-none">
        <form action={add} className="flex flex-col gap-4">
          <h2 className="font-bold tracking-tight">Add an account</h2>
          {online.length === 0 ? (
            <p className="text-sm text-muted-foreground">No computer is online.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Select name="provider" defaultValue="claude_code">
                <SelectTrigger aria-label="Provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude_code">Claude</SelectItem>
                  <SelectItem value="codex">Codex (ChatGPT)</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">on</span>
              <Select name="computerId" defaultValue={online[0]?.id}>
                <SelectTrigger aria-label="Computer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {online.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {computerName(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button className="ml-auto">Sign in</Button>
            </div>
          )}
        </form>
      </Card>
    </div>
  )
}

function AccountCard({
  account: a,
  login,
  onAct,
}: {
  account: Account
  login: AccountLogin | null
  onAct: (p: Promise<unknown>) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const exhausted = a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()
  const signingIn =
    a.status === 'signing_in' && login && login.state !== 'done' && login.state !== 'failed'

  return (
    <Card className={cn('gap-4 p-5', a.isDefault && 'border-2 border-primary')}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 font-bold">
            {a.label}
            {a.isDefault && (
              <Badge variant="secondary" className="bg-primary/15 font-semibold text-primary">
                default
              </Badge>
            )}
          </span>
          <span className="text-sm text-muted-foreground">
            {[
              a.email,
              a.plan,
              a.computer.kind === 'cloud' ? 'workspace computer' : a.computer.name,
              a.source === 'machine' && "this machine's own login",
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        {exhausted ? (
          <StatusBadge
            status="exhausted"
            tone="warning"
            label={`out of usage until ${resetLabel(a.exhaustedUntil)}`}
          />
        ) : a.status === 'needs_sign_in' ? (
          <StatusBadge status="needs_sign_in" tone="destructive" label="needs sign-in" />
        ) : a.status === 'signing_in' ? (
          <StatusBadge status="signing_in" tone="warning" label="signing in" />
        ) : (
          <StatusBadge status="ready" tone="success" />
        )}
      </div>

      {a.lastUsage && a.lastUsage.length > 0 && (
        <div className="flex flex-col gap-3">
          {a.lastUsage.map((l) => {
            const percent = Math.round(l.utilization * 100)
            return (
              <div key={l.window} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    <span className="capitalize">{l.window.replace('_', ' ')}</span>
                    {l.resetsAt && ` · resets ${resetLabel(l.resetsAt)}`}
                  </span>
                  <span className="font-mono">{percent}%</span>
                </div>
                <Progress
                  value={Math.min(100, Math.max(0, percent))}
                  aria-label={`${l.window.replace('_', ' ')} usage`}
                />
              </div>
            )
          })}
        </div>
      )}

      {signingIn && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm">
          {login.state === 'starting' && (
            <p className="text-muted-foreground">
              Starting {harnessLabel(a.provider)} sign-in on the computer…
            </p>
          )}
          {login.state === 'open_url' && login.flow === 'device' && (
            <>
              <p>
                1. Open{' '}
                <a
                  href={login.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {login.url}
                </a>{' '}
                and sign in to ChatGPT.
              </p>
              <p>
                2. Enter this code there:{' '}
                <code className="font-mono text-lg font-semibold">{login.userCode}</code>
              </p>
              <p className="text-muted-foreground">This page updates when you are done.</p>
            </>
          )}
          {login.state === 'open_url' && login.flow === 'paste' && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void onAct(api(`/accounts/${a.id}/code`, { body: { code } }))
              }}
            >
              <p className="flex items-center gap-2">
                1.{' '}
                <Button asChild size="sm">
                  <a href={login.url} target="_blank" rel="noreferrer">
                    Open Claude sign-in
                  </a>
                </Button>
              </p>
              <p>2. Sign in to the Claude account you want to add. Claude then shows a code.</p>
              <div className="flex items-center gap-2">
                <Label htmlFor={`code-${a.id}`} className="sr-only">
                  Sign-in code
                </Label>
                <Input
                  id={`code-${a.id}`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="3. Paste the code here"
                  autoComplete="off"
                  className="flex-1 bg-card"
                />
                <Button disabled={!code.trim()}>Finish</Button>
              </div>
            </form>
          )}
          {login.state === 'verifying' && (
            <p className="text-muted-foreground">Finishing sign-in…</p>
          )}
        </div>
      )}
      {login?.state === 'failed' && (
        <p className="text-sm text-destructive-text">Sign-in failed: {login.error}</p>
      )}

      <div className="mt-auto flex flex-wrap justify-end gap-2">
        {!a.isDefault && a.status === 'ready' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void onAct(api(`/accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }))
            }
          >
            Make default
          </Button>
        )}
        {a.source === 'brigade' &&
          (a.status === 'needs_sign_in' || (a.status === 'signing_in' && !signingIn)) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onAct(api(`/accounts/${a.id}/sign-in`, { method: 'POST' }))}
            >
              Sign in again
            </Button>
          )}
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            if (
              confirm(
                `Remove ${a.label}? ${a.source === 'brigade' ? 'Its login is deleted from the computer.' : 'The login stays on your machine.'}`,
              )
            ) {
              void onAct(api(`/accounts/${a.id}`, { method: 'DELETE' }))
            }
          }}
        >
          Remove
        </Button>
      </div>
    </Card>
  )
}
