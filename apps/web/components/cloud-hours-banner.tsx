'use client'
// Brigade Cloud Starter's hours at the foot of the sidebar, once they run low (docs/billing.md,
// Starter): from 80% of the period's hours, how many are used and when they start over, with
// Upgrade to Max for owners and admins; at 100%, that the cloud computer sleeps until then. Not
// dismissible: past the hours, teammates' cloud work waits. Folded to icons, a round button.
import { Gauge } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Hint } from '@/components/ui/tooltip'
import { upgradeToCloud, useApi, type ComputersResponse } from '@/lib/api'
import { openSettings } from '@/lib/settings-dialog'

/** The share of the period's hours from which the card shows. */
export const SHOW_FROM = 0.8

/** How often the hours are read again while the dashboard is open. */
const EVERY_MS = 5 * 60_000

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })

/**
 * The bar's colours for a share of the hours: orange from SHOW_FROM, red once used up, the
 * account cards' tones (account-card.tsx). The app's own colour below.
 */
export function hoursTone(used: number, included: number) {
  if (used >= included) return { track: 'bg-destructive/20', fill: 'bg-destructive' }
  if (used >= included * SHOW_FROM) return { track: 'bg-warning/20', fill: 'bg-warning' }
  return null
}

/** What the card says for these hours, or null below SHOW_FROM. */
export function hoursCard(hours: { used: number; included: number; resetsAt: string }) {
  if (hours.used < hours.included * SHOW_FROM) return null
  const usedUp = hours.used >= hours.included
  return {
    usedUp,
    tone: hoursTone(hours.used, hours.included)!,
    percent: Math.min(100, (hours.used / hours.included) * 100),
    title: usedUp
      ? 'Cloud hours used up'
      : `${Math.floor(hours.used)} of ${hours.included} cloud hours`,
    line: usedUp
      ? `Back on ${day(hours.resetsAt)}. Teammates’ cloud work waits until then.`
      : `Starts over on ${day(hours.resetsAt)}`,
  }
}

export function CloudHoursBanner({ admin }: { admin: boolean }) {
  const computers = useApi<ComputersResponse>('/computers')
  const { reload } = computers
  const [opening, setOpening] = useState(false)

  // Hours go by without an event: read them again now and then.
  useEffect(() => {
    const timer = setInterval(() => void reload(), EVERY_MS)
    return () => clearInterval(timer)
  }, [reload])

  const hours = computers.data?.cloudHours
  const card = hours ? hoursCard(hours) : null
  if (!card) return null

  // Stripe's portal at the upgrade's confirmation; Billing, where it says why, if that fails.
  async function upgrade() {
    setOpening(true)
    try {
      await upgradeToCloud()
    } catch {
      openSettings('/app/billing')
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="mx-2 group-data-[collapsible=icon]:mx-0">
      <div className="bg-card flex flex-col gap-2 rounded-lg border p-3 text-sm group-data-[collapsible=icon]:hidden">
        <p className="font-semibold">{card.title}</p>
        <Progress
          value={card.percent}
          aria-label="Cloud computer hours used"
          className={card.tone.track}
          indicatorClassName={card.tone.fill}
        />
        <p className="text-muted-foreground text-[0.8125rem] leading-snug">
          {card.line}
          {!admin && ' Ask an owner or admin to upgrade.'}
        </p>
        {admin && (
          <Button
            size="sm"
            className="mt-0.5 w-full rounded-full"
            disabled={opening}
            onClick={() => void upgrade()}
          >
            {opening && <ActivityIndicator label="Opening Stripe" />}
            Upgrade to Max
          </Button>
        )}
      </div>
      <Hint side="right" label={`${card.title}. ${card.line}`}>
        <button
          type="button"
          onClick={() => (admin ? void upgrade() : openSettings('/app/billing'))}
          aria-label={card.title}
          className="bg-primary text-primary-foreground hidden size-8 items-center justify-center rounded-full group-data-[collapsible=icon]:flex"
        >
          {opening ? <ActivityIndicator /> : <Gauge className="size-4" aria-hidden />}
        </button>
      </Hint>
    </div>
  )
}
