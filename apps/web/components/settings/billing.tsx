'use client'
// Billing: the workspace's plan. Brigade is free on members' own machines (Free); Brigade Cloud,
// per workspace, adds the cloud computer: Max without a limit of hours, Starter for a number of
// hours a month. Owners and admins subscribe through Stripe Checkout, move from Starter to Max
// in Stripe's portal, and manage the subscription (card, invoices, cancel) there.
import type { BillingResponse } from '@brigade/contracts'
import { Check, Cloud, Gauge, Laptop } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { hoursTone } from '@/components/cloud-hours-banner'
import { Progress } from '@/components/ui/progress'
import { api, openStripe, subscribeToCloud, upgradeToCloud, useApi } from '@/lib/api'
import { useSettingsParams } from '@/lib/settings-dialog'
import { cn } from '@/lib/utils'

type Tier = 'cloud' | 'starter'

/** Each plan's name, where the page names the workspace's own plan. */
const PLANS: Record<Tier, { name: string }> = {
  starter: { name: 'Starter' },
  // The tier's code name stays `cloud` (src/billing.ts PLANS): people see Max.
  cloud: { name: 'Max' },
}

/** Where Checkout charges in euros (Stripe picks by the customer's country): the euro zone. */
const EURO_REGIONS = new Set(
  'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' '),
)

/** The currency sign this browser's region pays in: € in the euro zone, else $. */
function useCurrency() {
  const [sign, setSign] = useState('$')
  useEffect(() => {
    const region = navigator.languages
      .map((language) => language.split('-')[1]?.toUpperCase())
      .find(Boolean)
    if (region && EURO_REGIONS.has(region)) setSign('€')
  }, [])
  return sign
}

type Offer = {
  key: 'free' | Tier
  name: string
  icon: ReactNode
  /** The price a month, in the page's currency; 0 for Free. */
  amount: number
  /** Who it is for, in a line. */
  audience: string
  /** The plan below it, whose features it has too: its list opens with "Everything in …". */
  includes?: string
  /** What sets it apart, in bold. */
  headline: string
  features: string[]
}

/**
 * The three plans side by side: Free, where every workspace starts, then the two Cloud plans,
 * each opening with the plan below it and what it adds. Only what the product does: check a
 * line against the code before changing it.
 */
const OFFERS: Offer[] = [
  {
    key: 'free',
    name: 'Free',
    icon: <Laptop />,
    amount: 0,
    audience: 'For trying it on your own computer',
    headline: 'Unlimited teammates, threads and members',
    features: [
      'Claude Code or Codex, on your own Claude or ChatGPT plan',
      'GitHub, Notion, Linear, Stripe and many more Apps',
      'Apps for Mac, Windows and Linux, and alerts on your phone',
      'Teammates work while your computer is on',
    ],
  },
  {
    key: 'starter',
    name: 'Starter',
    icon: <Gauge />,
    amount: 15,
    audience: 'Always-on teammates at the lowest price',
    includes: 'Free',
    headline: 'A cloud computer for 100 hours a month',
    features: [
      'Teammates keep working with your laptop closed',
      'Schedules and triggers run on time, even at 3 a.m.',
      'A live desktop you can watch or take over',
      'An email address for each teammate, with the Inbox',
      'Dictation in every message box',
    ],
  },
  {
    key: 'cloud',
    name: 'Max',
    icon: <Cloud />,
    amount: 99,
    audience: 'For a team that works around the clock',
    includes: 'Starter',
    headline: 'A cloud computer with no hour limit, 24/7',
    features: ['Priority support'],
  },
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

/** A plan's name and line, beside its icon. */
function PlanHead({ tier, line, dot }: { tier: Tier; line: ReactNode; dot?: boolean }) {
  return (
    <div className="flex items-start gap-4">
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-5"
      >
        {tier === 'starter' ? <Gauge /> : <Cloud />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold">{PLANS[tier].name}</span>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {dot !== undefined && (
            <span
              aria-hidden
              className={cn(
                'size-2 shrink-0 rounded-full',
                dot ? 'bg-primary' : 'bg-muted-foreground/40',
              )}
            />
          )}
          {line}
        </span>
      </div>
    </div>
  )
}

/** Starter's hours this period: how many the cloud computer ran, and when they start over. */
function Hours({ hours }: { hours: NonNullable<NonNullable<BillingResponse['plan']>['hours']> }) {
  const left = hours.used < hours.included
  const used = Math.min(hours.used, hours.included)
  const tone = hoursTone(hours.used, hours.included)
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/60 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">
          {used.toLocaleString(undefined, { maximumFractionDigits: 1 })} of {hours.included} hours
          used
        </span>
        <span className="text-muted-foreground">Starts over on {day(hours.resetsAt)}</span>
      </div>
      <Progress
        value={(used / hours.included) * 100}
        aria-label="Cloud computer hours used"
        className={tone?.track}
        indicatorClassName={tone?.fill}
      />
      <p className="text-[0.8125rem] leading-snug text-muted-foreground">
        {left
          ? 'Hours count while the cloud computer is on. It goes to sleep 30 minutes after teammates finish, and wakes when they have work.'
          : 'This month’s hours are used up: the cloud computer sleeps, and teammates’ work waits for it, until they start over or you upgrade.'}
      </p>
    </div>
  )
}

export default function BillingPage() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const billing = useApi<BillingResponse>('/billing')
  // The Stripe page being opened, by the button that asked for it: its spinner, and every
  // button off meanwhile.
  const [opening, setOpening] = useState<string | null>(null)
  const busy = opening !== null
  const [error, setError] = useState<string>()
  const [welcome, setWelcome] = useState(false)
  const [upgradedNow, setUpgradedNow] = useState(false)

  // Back from Checkout (/app/billing?subscribed=1), or the portal's upgrade (?upgraded=1): say so.
  const params = useSettingsParams()
  const subscribed = params.has('subscribed')
  const upgraded = params.has('upgraded')
  useEffect(() => {
    if (subscribed) setWelcome(true)
  }, [subscribed])
  useEffect(() => {
    if (upgraded) setUpgradedNow(true)
  }, [upgraded])

  async function go(key: string, open: () => Promise<void>) {
    setOpening(key)
    setError(undefined)
    try {
      await open()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // Opened in a new tab (a preview's frame), this page stays.
      setOpening(null)
    }
  }

  const manage = () =>
    go('manage', () =>
      openStripe(
        async () => (await api<{ url: string }>('/billing/portal', { method: 'POST' })).url,
      ),
    )

  const data = billing.data
  const plan = data?.plan
  const active = !!plan?.active
  const tier: Tier = plan?.tier ?? 'cloud'
  const currency = useCurrency()

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Billing</h1>
        <p className="max-w-prose text-muted-foreground">
          Your teammates run free on your own computer. Add a cloud computer so they keep working
          when it’s off. {!admin && 'Only owners and admins can change the plan.'}
        </p>
      </header>

      {welcome && active && (
        <p role="status" className="rounded-lg bg-accent p-4 text-sm text-accent-foreground">
          Welcome to {PLANS[tier].name}. Your cloud computer is being set up: it shows in Computers
          within a few minutes.
        </p>
      )}
      {upgradedNow && active && tier === 'cloud' && (
        <p role="status" className="rounded-lg bg-accent p-4 text-sm text-accent-foreground">
          You’re on Max now: the cloud computer has no limit of hours.
        </p>
      )}

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data.enabled ? (
        <Card className="max-w-xl px-6 py-5 text-sm text-muted-foreground">
          Billing is off on this Brigade server: the cloud computer, when there is one, is included.
        </Card>
      ) : active ? (
        <Card className="max-w-xl gap-5 px-6 py-5">
          <PlanHead tier={tier} line={standing(plan)} dot />
          {plan.hours && <Hours hours={plan.hours} />}
          {admin && !plan.complimentary && (
            <div className="flex flex-wrap gap-2">
              {tier === 'starter' && (
                <Button disabled={busy} onClick={() => void go('upgrade', () => upgradeToCloud())}>
                  {opening === 'upgrade' && <ActivityIndicator label="Opening Stripe" />}
                  Upgrade to Max · $99
                </Button>
              )}
              <Button variant="outline" disabled={busy} onClick={() => void manage()}>
                {opening === 'manage' && <ActivityIndicator label="Opening Stripe" />}
                Manage billing
              </Button>
            </div>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {plan && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
              {PLANS[tier].name}: {standing(plan)}
              {admin && !plan.complimentary && (
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={busy}
                  onClick={() => void manage()}
                >
                  Invoices
                </Button>
              )}
            </p>
          )}
          <div className="grid max-w-4xl gap-4 md:grid-cols-3">
            {OFFERS.map((offer) => {
              const current = offer.key === 'free'
              const featured = offer.key === 'cloud'
              return (
                <Card
                  key={offer.key}
                  className={cn('gap-4 px-5 py-5', featured && 'border-primary/60')}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-4"
                    >
                      {offer.icon}
                    </span>
                    <span className="font-semibold">{offer.name}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <p className="flex items-baseline gap-1">
                      <span className="text-3xl font-extrabold tracking-tight">
                        {currency}
                        {offer.amount}
                      </span>
                      {offer.amount > 0 && (
                        <span className="text-sm text-muted-foreground">/ month</span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">{offer.audience}</p>
                  </div>
                  <ul className="flex flex-col gap-2 text-sm">
                    {offer.includes && (
                      <li className="flex gap-2">
                        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                        Everything in {offer.includes}
                      </li>
                    )}
                    <li className="flex gap-2 font-semibold">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                      {offer.headline}
                    </li>
                    {offer.features.map((feature) => (
                      <li key={feature} className="flex gap-2">
                        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  {current ? (
                    <Button variant="outline" className="mt-auto" disabled>
                      Current plan
                    </Button>
                  ) : (
                    admin && (
                      <Button
                        className="mt-auto"
                        variant={featured ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={() =>
                          void go(offer.key, () => subscribeToCloud('billing', offer.key as Tier))
                        }
                      >
                        {opening === offer.key && <ActivityIndicator label="Opening Stripe" />}
                        Get {offer.name}
                      </Button>
                    )
                  )}
                </Card>
              )
            })}
          </div>
          <p className="max-w-4xl text-[0.8125rem] leading-snug text-muted-foreground">
            Teammates run on your own Claude or ChatGPT plan, and your provider bills you for it. A
            cloud hour counts while the cloud computer is on; it goes to sleep 30 minutes after
            teammates finish. Switch or cancel anytime.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
