'use client'
import { useState } from 'react'
import { Cloud, Laptop, ShieldCheck } from 'lucide-react'
import { AccountRow, machineName } from '@/components/account-card'
import { HarnessLogo } from '@/components/harness-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  api,
  harnessLabel,
  useApi,
  usableComputers,
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

  const add = (provider: Account['provider'], computerId: string) =>
    act(api('/accounts', { body: { computerId, provider } }))

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
          <h2
            id={`accounts-${provider}`}
            className="flex items-center gap-2 text-lg font-bold tracking-tight"
          >
            <HarnessLogo harness={provider} className="size-5" />
            {harnessLabel(provider)}
            <span className="font-semibold text-muted-foreground">
              {byProvider(provider).length}
            </span>
          </h2>
          {byProvider(provider).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No {harnessLabel(provider)} accounts yet.
            </p>
          ) : (
            <Card className="gap-0 divide-y overflow-hidden py-0">
              {byProvider(provider).map((a) => (
                <AccountRow key={a.id} account={a} login={logins[a.id] ?? a.login} onAct={act} />
              ))}
            </Card>
          )}
        </section>
      ))}

      <section aria-labelledby="accounts-add" className="flex flex-col gap-3">
        <h2 id="accounts-add" className="sr-only">
          Add an account
        </h2>
        {online.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No computer is online, so no account can be added right now.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(['claude_code', 'codex'] as const).map((provider) => {
              const label = (
                <>
                  <HarnessLogo harness={provider} />
                  Add {harnessLabel(provider)} account
                </>
              )
              // With one computer there is nothing to pick: sign in there at once.
              const [only] = online
              if (only && online.length === 1)
                return (
                  <Button
                    key={provider}
                    variant="outline"
                    onClick={() => void add(provider, only.id)}
                  >
                    {label}
                  </Button>
                )
              return (
                <DropdownMenu key={provider}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">{label}</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-60">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      Sign in with {provider === 'codex' ? 'ChatGPT' : 'Claude'} on
                    </DropdownMenuLabel>
                    {online.map((c) => (
                      <DropdownMenuItem key={c.id} onSelect={() => void add(provider, c.id)}>
                        {c.kind === 'cloud' ? <Cloud aria-hidden /> : <Laptop aria-hidden />}
                        <span className="truncate">{machineName(c)}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
