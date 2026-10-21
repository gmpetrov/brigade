'use client'
// Billing: the workspace's plan. Brigade is free on members' own machines; Brigade Cloud,
// per workspace, adds the cloud computer. Owners and admins subscribe through Stripe
// Checkout and manage the subscription (card, invoices, cancel) in Stripe's portal.
import type { BillingResponse } from '@brigade/contracts'
import { Check, Cloud } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, subscribeToCloud, useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

const FEATURES = [
  'Teammates keep working when your Mac is asleep, closed or you don’t have one',
  'Brigade’s cloud computer, shared by the workspace, up to 4 threads at once',
  'Still on your own Claude or ChatGPT plan: no charge for AI usage',
]

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/** What the plan's status means for the workspace, in a line. */
function standing(plan: NonNullable<BillingResponse['plan']>) {
  if (plan.complimentary) return 'Included by Brigade'
  if (plan.status === 'past_due') return 'Payment failed: update your card to keep it'
  if (plan.status === 'trialing' && plan.periodEnd) return `Trial until ${day(plan.periodEnd)}`
  if (plan.cancelAt) return `Ends on ${day(plan.cancelAt)}`
  if (plan.active && plan.periodEnd) return `Renews on ${day(plan.periodEnd)}`
  if (plan.active) return 'Active'
  return 'Ended'
}

export default function BillingPage() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const billing = useApi<BillingResponse>('/billing')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [welcome, setWelcome] = useState(false)

  // Back from Checkout: say so once, and drop it from the address.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('subscribed')) return
    setWelcome(true)
    url.searchParams.delete('subscribed')
    window.history.replaceState(null, '', url)
  }, [])

  async function go(open: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await open()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const manage = () =>
    go(async () => {
      const { url } = await api<{ url: string }>('/billing/portal', { method: 'POST' })
      window.location.assign(url)
    })

  const data = billing.data
  const plan = data?.plan
  const active = !!plan?.active

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Billing</h1>
        <p className="max-w-prose text-muted-foreground">
          Brigade is free on your own machines. Brigade Cloud adds the cloud computer, for this
          workspace. {!admin && 'Only owners and admins can change the plan.'}
        </p>
      </header>

      {welcome && active && (
        <p role="status" className="rounded-lg bg-accent p-4 text-sm text-accent-foreground">
          Welcome to Brigade Cloud. Your cloud computer is being set up: it shows in Computers
          within a few minutes.
        </p>
      )}

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data.enabled ? (
        <Card className="max-w-xl px-6 py-5 text-sm text-muted-foreground">
          Billing is off on this Brigade server: the cloud computer, when there is one, is included.
        </Card>
      ) : (
        <Card className="max-w-xl gap-5 px-6 py-5">
          <div className="flex items-start gap-4">
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-5"
            >
              <Cloud />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-semibold">Brigade Cloud</span>
              {plan ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      active ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                  />
                  {standing(plan)}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">
                  $99 a month per workspace, or €99 in the euro zone
                </span>
              )}
            </div>
          </div>

          {!active && (
            <ul className="flex flex-col gap-2 text-sm">
              {FEATURES.map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  {feature}
                </li>
              ))}
            </ul>
          )}

          {admin &&
            (active ? (
              !plan.complimentary && (
                <Button
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => void manage()}
                >
                  Manage billing
                </Button>
              )
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void go(() => subscribeToCloud())}>
                  {plan ? 'Subscribe again' : 'Subscribe'}
                </Button>
                {plan && !plan.complimentary && (
                  <Button variant="outline" disabled={busy} onClick={() => void manage()}>
                    Invoices
                  </Button>
                )}
              </div>
            ))}
        </Card>
      )}

      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
