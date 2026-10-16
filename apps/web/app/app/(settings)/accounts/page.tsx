'use client'
import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { AccountCard } from '@/components/account-card'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
          Your Claude and Codex subscriptions. Add several of each: when one runs out of usage, your
          threads continue on the next. Accounts are yours alone; nobody else&apos;s threads use
          them.
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
