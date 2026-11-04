'use client'
// The Inbox before Brigade Cloud: Brigade's own addresses send and receive through Resend,
// which charges for each mail, so they come with the paid plan. A few sample emails fade out
// under the offer, with the address one of the workspace's teammates would get (or, with only
// Chief, the mail icon). The samples
// are made up, never the workspace's own mail.
import type { InboxPlan } from '@brigade/contracts'
import { Check, Globe, Mail } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { subscribeToCloud } from '@/lib/api'

const SAMPLES = [
  { from: 'Claire Martin', subject: 'Re: Invoice for October', snippet: 'Could you resend it?' },
  { from: 'Hugo (Acme)', subject: 'Quick question about the API limits', snippet: 'Hi there' },
  { from: 'Nadia', subject: 'Meeting moved to Thursday', snippet: '3pm works for us' },
]

export function InboxPaywall({ plan }: { plan: InboxPlan }) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const teammate = plan.teammate

  async function subscribe() {
    setBusy(true)
    setError(undefined)
    try {
      await subscribeToCloud()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col">
      {/* No Mailboxes gear: nothing there works until the plan is on. */}
      <header className="flex items-baseline gap-2 border-b px-4 pt-6 pb-3 md:px-5">
        <h1 className="text-2xl font-extrabold tracking-tight">Inbox</h1>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          Every email your mailboxes received
        </span>
      </header>

      {/* One column: the sample mail fades out right above the offer, at any width. */}
      <div className="mx-auto flex w-full max-w-md flex-col px-6 pt-6 pb-16">
        {/* Made-up mail, blurred and fading: what the Inbox holds once it is on. */}
        <ul
          aria-hidden
          className="pointer-events-none -mx-6 divide-y opacity-50 blur-[3px] select-none [mask-image:linear-gradient(black,transparent)]"
        >
          {SAMPLES.map((s) => (
            <li key={s.from} className="flex gap-3 px-6 py-3.5">
              <span className="size-8 flex-none rounded-full bg-muted" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{s.from}</span>
                <span className="truncate text-sm">{s.subject}</span>
                <span className="truncate text-sm text-muted-foreground">{s.snippet}</span>
              </div>
            </li>
          ))}
        </ul>

        <section
          aria-labelledby="inbox-paywall-title"
          className="relative -mt-8 flex flex-col gap-5"
        >
          {/* A teammate's own address when there is one; else (only Chief) the mail icon. */}
          {teammate && plan.address ? (
            <span className="inline-flex max-w-full items-center gap-2 self-start rounded-full border bg-card py-1 pr-3 pl-1 font-mono text-xs">
              <TeammateAvatar teammate={teammate} className="size-6" />
              <span className="truncate">{plan.address}</span>
            </span>
          ) : (
            <span
              aria-hidden
              className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary"
            >
              <Mail className="size-5" />
            </span>
          )}
          <div className="flex flex-col gap-1.5">
            <h2 id="inbox-paywall-title" className="text-xl font-bold tracking-tight">
              {teammate
                ? `${teammate.name} could be answering your email`
                : 'Let your teammates answer your email'}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Give each teammate an inbox of their own. They handle what’s clear and leave the rest
              in To do.
            </p>
          </div>
          <ul className="flex flex-col border-t">
            <Perk icon={<Mail />} title="An address per teammate">
              Turn it on for each teammate you choose
            </Perk>
            <Perk icon={<Check />} title="You approve what matters">
              Or every email, if you prefer
            </Perk>
            <Perk icon={<Globe />} title="Your own domain">
              Send and receive on your company’s domain
            </Perk>
          </ul>
          {admin ? (
            <Button className="self-start" disabled={busy} onClick={() => void subscribe()}>
              Get Brigade Cloud · $99/mo
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Email comes with Brigade Cloud, $99 a month. Ask an owner or admin to subscribe.
            </p>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
        </section>
      </div>
    </div>
  )
}

function Perk({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-b py-3">
      <span
        aria-hidden
        className="flex size-8 flex-none items-center justify-center rounded-lg bg-primary/15 text-primary [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-sm text-muted-foreground">{children}</span>
      </div>
    </li>
  )
}
