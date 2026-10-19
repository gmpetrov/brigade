'use client'
// The cards a teammate puts up while installing a playbook from the chat: the playbook
// (show_playbook), its dry run going (start_dry_run), its report, one card per event
// (dry_run_report), and the summary whose Activate button turns it on (activate_playbook).
import type {
  PlaybookDryRunEvent,
  PlaybookDryRunView,
  PlaybookInstallationView,
  PlaybookLevel,
  PlaybookTemplate,
} from '@brigade/contracts'
import { BookOpenCheck, ChevronRight, FlaskConical, Power } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { StatusBadge, StatusDot } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { api, useApi } from '@/lib/api'
import { useLive } from '@/lib/use-live'

const APP_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  github: 'GitHub',
  stripe: 'Stripe',
  mixpanel: 'Mixpanel',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  resend: 'Resend',
  linear: 'Linear',
  notion: 'Notion',
}
const appName = (kind: string) => APP_NAMES[kind] ?? kind.replace(/_/g, ' ')

const LEVEL_WORDS: Record<PlaybookLevel, string> = {
  ask: 'Asks first',
  auto: 'On its own',
  deny: 'Never',
}

const minutes = (n: number) => (n < 1 ? 'under a minute' : `${Math.round(n)} min`)

/** A small uppercase label heading a card. */
function Label({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-muted-foreground uppercase [&>svg]:size-3.5">
      {icon}
      {children}
    </div>
  )
}

function AppList({ apps }: { apps: { kind: string; access: string; optional?: boolean }[] }) {
  return (
    <ul className="flex flex-col divide-y rounded-lg bg-muted/60">
      {apps.map((a) => (
        <li key={a.kind} className="flex items-center gap-2.5 px-3 py-2 text-sm">
          <ProviderLogo kind={a.kind as ProviderKind} className="size-4" />
          <span className="min-w-0 flex-1 truncate">{appName(a.kind)}</span>
          <span className="text-xs text-muted-foreground">
            {a.access === 'read' ? 'Reads' : 'Reads and writes'}
            {a.optional ? ' · optional' : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** show_playbook: what it does, its Apps, its author and its version. */
export function PlaybookCard({ playbookKey }: { playbookKey: string }) {
  const catalog = useApi<PlaybookTemplate[]>('/playbooks/catalog')
  const playbook = catalog.data?.find((t) => t.id === playbookKey)
  if (catalog.error || (catalog.data && !playbook)) return null
  if (!playbook) return <Skeleton className="h-40 w-full max-w-xl rounded-xl" />
  return (
    <Card className="max-w-xl gap-3 px-5 py-4">
      <Label icon={<BookOpenCheck aria-hidden />}>Playbook</Label>
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{playbook.name}</span>
        <span className="text-xs text-muted-foreground">
          By {playbook.source === 'brigade' ? 'Brigade' : playbook.source} · v{playbook.version}
        </span>
      </div>
      <p className="text-sm">{playbook.description}</p>
      <AppList apps={playbook.apps} />
      {playbook.actions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          What it may do: {playbook.actions.map((a) => a.label.toLowerCase()).join(', ')}. Each one
          asks first once it is active.
        </p>
      )}
    </Card>
  )
}

/** The latest dry run, refreshed while its threads move. */
function useDryRun(installationId: string) {
  const dryRun = useApi<PlaybookDryRunView>(`/playbooks/${installationId}/dry-run`)
  const { reload } = dryRun
  const running = dryRun.data?.status === 'running'
  useLive((message) => {
    if (message.type === 'thread.updated') void reload()
  })
  // Its threads are out of the sidebar, so not every change reaches this page: look again now and then.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void reload(), 10_000)
    return () => clearInterval(timer)
  }, [running, reload])
  return dryRun
}

/** "6 min, about 40 min a week (25 events)". */
function costLine(d: PlaybookDryRunView) {
  return [
    `${minutes(d.minutes)} of session on the owner's subscription`,
    d.week && `about ${minutes(d.week.minutes)} a week at this pace (${d.week.events} events)`,
  ]
    .filter(Boolean)
    .join(', ')
}

/** start_dry_run: how far it is. The report itself comes with dry_run_report. */
export function DryRunProgress({ installationId }: { installationId: string }) {
  const { data } = useDryRun(installationId)
  if (!data) return null
  const done = data.status !== 'running'
  return (
    <Card className="max-w-xl gap-2 px-5 py-4">
      <div className="flex items-center gap-2">
        <Label icon={<FlaskConical aria-hidden />}>Dry run · {data.name}</Label>
        <span className="flex-1" />
        <StatusBadge
          status={done ? 'done' : 'running'}
          tone={done ? 'success' : 'neutral'}
          label={done ? 'Done' : `${data.finished}/${data.events.length}`}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {done
          ? `Replayed ${data.events.length} past event${data.events.length === 1 ? '' : 's'}. Nothing was sent.`
          : `Replaying ${data.events.length} past event${data.events.length === 1 ? '' : 's'}, a few at a time. Every write is simulated: nothing is sent.`}
      </p>
      {data.minutes > 0 && <p className="text-xs text-muted-foreground">{costLine(data)}</p>}
    </Card>
  )
}

const EVENT_DOTS: Record<PlaybookDryRunEvent['status'], string> = {
  waiting: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
}

/** A write it would have made: an email's recipients, subject and body; else its arguments. */
function WouldDo({ write }: { write: PlaybookDryRunEvent['writes'][number] }) {
  const input = (write.input ?? {}) as Record<string, unknown>
  const mail = typeof input.body === 'string' && Array.isArray(input.to)
  return (
    <Collapsible className="rounded-lg bg-muted/60 text-sm">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{write.action ?? write.operation.replace(/_/g, ' ')}</span>
          <span className="text-muted-foreground"> · {write.target}</span>
        </span>
        <ChevronRight
          aria-hidden
          className="size-3.5 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        {mail ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              To {(input.to as string[]).join(', ')}
              {typeof input.subject === 'string' && ` · ${input.subject}`}
            </p>
            <p className="leading-relaxed wrap-anywhere whitespace-pre-wrap">
              {input.body as string}
            </p>
          </div>
        ) : (
          <pre className="max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {JSON.stringify(write.input, null, 2)}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function EventCard({ event: e }: { event: PlaybookDryRunEvent }) {
  return (
    <Card className="max-w-xl gap-2.5 px-5 py-4">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={EVENT_DOTS[e.status]} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{e.title}</span>
        {e.case && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
            {e.case.replace(/_/g, ' ')}
          </span>
        )}
      </div>
      {e.summary && <p className="text-sm">{e.summary}</p>}
      {e.writes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Would have done</span>
          {e.writes.map((w, i) => (
            <WouldDo key={i} write={w} />
          ))}
        </div>
      ) : (
        e.status === 'done' && (
          <p className="text-xs text-muted-foreground">Would have written nothing.</p>
        )
      )}
      {e.pushes > 0 && (
        <p className="text-xs text-muted-foreground">
          {e.pushes} push{e.pushes === 1 ? '' : 'es'} kept back: the code stayed on the computer.
        </p>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{minutes(e.minutes)}</span>
        {e.threadId && (
          <Link href={`/app/threads/${e.threadId}`} className="underline-offset-2 hover:underline">
            Open its thread
          </Link>
        )}
      </div>
    </Card>
  )
}

/** dry_run_report: its cost, then one card per event. */
export function DryRunReport({ installationId }: { installationId: string }) {
  const { data } = useDryRun(installationId)
  if (!data) return null
  return (
    <div className="flex flex-col gap-2.5">
      <Card className="max-w-xl gap-1.5 px-5 py-4">
        <Label icon={<FlaskConical aria-hidden />}>Dry run report · {data.name}</Label>
        <p className="text-sm">
          {data.events.length} past event{data.events.length === 1 ? '' : 's'} replayed
          {data.status === 'running' && `, ${data.finished} done so far`}. Nothing was sent.
        </p>
        <p className="text-xs text-muted-foreground">{costLine(data)}</p>
      </Card>
      {data.events.map((e) => (
        <EventCard key={e.runId} event={e} />
      ))}
    </div>
  )
}

/** activate_playbook: what it will do and on whose accounts, and the button that turns it on. */
export function ActivationCard({
  installationId,
  threadId,
  onSend,
}: {
  installationId: string
  threadId?: string
  onSend?: (text: string) => Promise<void>
}) {
  const { me } = useDashboard()
  const playbook = useApi<PlaybookInstallationView>(`/playbooks/${installationId}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { reload } = playbook
  useLive((message) => {
    if (message.type === 'tickets.updated' || message.type === 'thread.updated') void reload()
  })
  const p = playbook.data
  if (playbook.error) return null
  if (!p) return <Skeleton className="h-48 w-full max-w-xl rounded-xl" />
  const admin = isAdmin(me)
  const active = p.status === 'active' || p.status === 'paused'
  const asked = !!p.activationTicketId

  async function activate() {
    setBusy(true)
    setError(undefined)
    try {
      const { ticketId } = await api<{ ticketId: string | null }>(
        `/playbooks/${installationId}/activate`,
        { body: threadId ? { threadId } : {} },
      )
      await reload()
      await onSend?.(
        ticketId
          ? `Asked an owner or admin to activate the playbook ${p!.name}.`
          : `Activated the playbook ${p!.name}.`,
      )
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <Card className="max-w-xl gap-4 border-primary/40 px-5 py-4">
      <div className="flex items-center gap-2">
        <Label icon={<Power aria-hidden />}>Activate · {p.name}</Label>
        <span className="flex-1" />
        {(active || asked) && (
          <StatusBadge
            status={active ? 'answered' : 'pending'}
            tone={active ? 'success' : 'neutral'}
            label={active ? 'Active' : 'Asked an admin'}
          />
        )}
      </div>

      <section className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Settings</span>
        <ul className="flex flex-col divide-y rounded-lg bg-muted/60">
          {p.settings.map((s) => (
            <li key={s.key} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{s.ask ?? s.key}</span>
              <span className="max-w-[50%] truncate text-muted-foreground">
                {s.value === null ? '—' : String(s.value)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Apps</span>
        <AppList apps={p.apps} />
      </section>

      {p.actions.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Actions</span>
          <ul className="flex flex-col divide-y rounded-lg bg-muted/60">
            {p.actions.map((a) => (
              <li key={a.key} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium">
                  {LEVEL_WORDS[a.level]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <TeammateAvatar teammate={p.teammate} className="size-4" />
        <span className="font-medium text-foreground">{p.teammate.name}</span>
        runs it on {p.owner.id === me.memberId ? 'your' : `${p.owner.name}'s`} accounts and
        subscription.
      </p>

      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {active ? (
        <Link
          href={`/app/routines/playbooks/${p.id}`}
          className="text-sm font-medium underline-offset-2 hover:underline"
        >
          Open its sheet
        </Link>
      ) : asked && !admin ? (
        <p className="text-sm text-muted-foreground">
          An owner or admin activates it from Needs you.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy || !p.ready} onClick={() => void activate()}>
            Activate
          </Button>
          {!admin && (
            <span className="text-xs text-muted-foreground">
              An owner or admin approves it, in one ticket.
            </span>
          )}
        </div>
      )}
    </Card>
  )
}
