'use client'
import { useState } from 'react'
import { Cloud, EllipsisVertical, Laptop } from 'lucide-react'
import { HarnessLogo } from '@/components/harness-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { Hint } from '@/components/ui/tooltip'
import { api, harnessLabel, type Account, type AccountLogin } from '@/lib/api'

export const resetLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : ''

/** A machine as people call it: "Georges-MacBook-Pro.local" reads "Georges MacBook Pro". */
export const machineName = (computer: Pick<Account['computer'], 'kind' | 'name'>) =>
  computer.kind === 'cloud'
    ? 'Cloud computer'
    : computer.name.replace(/\.local$/, '').replace(/[-_]+/g, ' ')

/** Usage windows, short: five_hour is 5h, seven_day 7d, seven_day_opus 7d Opus. */
const WINDOWS: Record<string, [short: string, long: string]> = {
  five_hour: ['5h', '5-hour'],
  seven_day: ['7d', 'Weekly'],
  seven_day_opus: ['7d Opus', 'Weekly Opus'],
  seven_day_sonnet: ['7d Sonnet', 'Weekly Sonnet'],
}
const windowLabel = (w: string) => WINDOWS[w] ?? [w.replace(/_/g, ' '), w.replace(/_/g, ' ')]

/** Small meters for each usage window, amber once a window is nearly used up. */
export function UsageMeters({
  usage,
  className,
}: {
  usage: NonNullable<Account['lastUsage']>
  className?: string
}) {
  return (
    <div className={cn('flex w-full flex-col gap-1.5 sm:w-28', className)}>
      {usage.map((l) => {
        const percent = Math.min(100, Math.max(0, Math.round(l.utilization * 100)))
        const [short, long] = windowLabel(l.window)
        const title = `${long} limit: ${percent}% used${l.resetsAt ? `, resets ${resetLabel(l.resetsAt)}` : ''}`
        return (
          <Hint key={l.window} label={title}>
            <div className="flex items-center gap-2 text-xs">
              <span className="min-w-6 shrink-0 truncate text-muted-foreground">{short}</span>
              <div
                role="meter"
                aria-label={title}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10"
              >
                <div
                  className={cn('h-full rounded-full', percent >= 80 ? 'bg-warning' : 'bg-primary')}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span
                className={cn(
                  'w-7 shrink-0 text-right tabular-nums',
                  percent >= 80 ? 'text-warning' : 'text-muted-foreground',
                )}
              >
                {percent}%
              </span>
            </div>
          </Hint>
        )
      })}
    </div>
  )
}

/**
 * One AI account as a list row: where it runs, whose it is, its usage and a
 * status dot, with its actions in a ⋮ menu; its sign-in opens below while it runs.
 */
export function AccountRow({
  account: a,
  login,
  onAct,
  admin = false,
}: {
  account: Account
  login: AccountLogin | null
  onAct: (p: Promise<unknown>) => Promise<void>
  /** An owner or admin: may remove a shared account another member added. */
  admin?: boolean
}) {
  const [code, setCode] = useState('')
  const [email, setEmail] = useState(a.email ?? '')
  // On the cloud computer a Claude account is a token, which cannot tell whose it is.
  const asksEmail = a.provider === 'claude_code' && a.computer.kind === 'cloud'
  const exhausted = a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()
  const signingIn =
    a.status === 'signing_in' && login && login.state !== 'done' && login.state !== 'failed'
  const canSignInAgain =
    a.source === 'brigade' &&
    (a.status === 'needs_sign_in' || (a.status === 'signing_in' && !signingIn))
  const name = machineName(a.computer)
  // Who it is and its plan; a machine's own login without either says so.
  const details = [
    [a.email, a.plan && a.plan.charAt(0).toUpperCase() + a.plan.slice(1)]
      .filter(Boolean)
      .join(' · ') ||
      (a.source === 'machine'
        ? "Uses this machine's own login"
        : `Signed in with ${harnessLabel(a.provider)}`),
    // Another member's, shared with the workspace: whose it is.
    !a.mine && `added by ${a.addedBy}`,
  ]
    .filter(Boolean)
    .join(' · ')
  // Only whoever added it changes it; a shared one an owner or admin can remove too.
  const removable = a.mine || (a.shared && admin)
  const status = exhausted
    ? {
        tone: 'bg-warning',
        text: `Out of usage until ${resetLabel(a.exhaustedUntil)}`,
        word: 'text-warning',
      }
    : a.status === 'needs_sign_in'
      ? { tone: 'bg-destructive-text', text: 'Sign-in needed', word: 'text-destructive-text' }
      : a.status === 'signing_in'
        ? { tone: 'bg-warning', text: 'Signing in', word: 'text-warning' }
        : { tone: 'bg-success', text: 'Ready', word: null }
  const Where = a.computer.kind === 'cloud' ? Cloud : Laptop

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"
        >
          <Where className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium" title={a.computer.name}>
                {name}
              </span>
              {a.isDefault && (
                <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
                  Default
                </span>
              )}
            </span>
            <span className="truncate text-sm text-muted-foreground" title={details}>
              {details}
            </span>
            {status.word && (
              <span className={cn('text-xs font-medium', status.word)}>{status.text}</span>
            )}
          </div>
          {a.lastUsage && a.lastUsage.length > 0 && <UsageMeters usage={a.lastUsage} />}
        </div>
        <Hint label={status.text}>
          <span
            role="img"
            aria-label={status.text}
            className={cn('size-2 shrink-0 rounded-full', status.tone)}
          />
        </Hint>
        {(a.mine || removable) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${harnessLabel(a.provider)} on ${name} options`}
              >
                <EllipsisVertical aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {a.mine && !a.isDefault && a.status === 'ready' && (
                <DropdownMenuItem
                  onSelect={() =>
                    void onAct(
                      api(`/accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }),
                    )
                  }
                >
                  Make default
                </DropdownMenuItem>
              )}
              {a.mine && exhausted && (
                <DropdownMenuItem
                  onSelect={() =>
                    void onAct(
                      api(`/accounts/${a.id}`, { method: 'PATCH', body: { exhaustedUntil: null } }),
                    )
                  }
                >
                  Usage is back
                </DropdownMenuItem>
              )}
              {a.mine && canSignInAgain && (
                <DropdownMenuItem
                  onSelect={() => void onAct(api(`/accounts/${a.id}/sign-in`, { method: 'POST' }))}
                >
                  Sign in again
                </DropdownMenuItem>
              )}
              {a.mine &&
                ((!a.isDefault && a.status === 'ready') || exhausted || canSignInAgain) && (
                  <DropdownMenuSeparator />
                )}
              {removable && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    if (
                      confirm(
                        `Remove ${harnessLabel(a.provider)} on ${name}? ${a.source === 'brigade' ? 'Its login is deleted from the computer.' : 'The login stays on your machine.'}`,
                      )
                    ) {
                      void onAct(api(`/accounts/${a.id}`, { method: 'DELETE' }))
                    }
                  }}
                >
                  Remove
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {signingIn && (
        <div className="mx-4 mb-4 flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm">
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
                const given = asksEmail ? email.trim() : ''
                void onAct(
                  api(`/accounts/${a.id}/code`, {
                    body: { code, ...(given ? { email: given } : {}) },
                  }),
                )
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
              {asksEmail && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`email-${a.id}`}>
                    Account email{' '}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <p className="text-muted-foreground">
                    Claude doesn&apos;t tell Brigade which account this is. Add its email to tell
                    your accounts apart.
                  </p>
                  <Input
                    id={`email-${a.id}`}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="off"
                    className="bg-card"
                  />
                </div>
              )}
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
        <p className="px-4 pb-3 text-sm text-destructive-text">Sign-in failed: {login.error}</p>
      )}
    </div>
  )
}

/** One account on its own, in a card, where there is no list around it. */
export function AccountCard(props: Parameters<typeof AccountRow>[0]) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <AccountRow {...props} />
    </Card>
  )
}
