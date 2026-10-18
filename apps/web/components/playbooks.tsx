'use client'
import type {
  LoopActionView,
  LoopInstallationView,
  LoopLevel,
  LoopRunView,
  LoopTemplate,
} from '@brigade/contracts'
import { ArrowLeft, BookOpenCheck, MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { isAdmin, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { ProjectTag } from '@/components/projects'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { describeCron, scheduleTime, zoneName } from '@/components/schedules'
import { StatusDot } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api, projectQuery, useApi } from '@/lib/api'
import { useLive } from '@/lib/use-live'

const STATUS_WORDS: Record<LoopInstallationView['status'], string> = {
  setup: 'Waiting for activation',
  dry_run: 'Dry run',
  active: 'Active',
  paused: 'Paused',
}
/** The dot's tone, from StatusDot's words. */
const STATUS_DOTS: Record<LoopInstallationView['status'], string> = {
  setup: 'pending',
  dry_run: 'running',
  active: 'active',
  paused: 'paused',
}
const LEVEL_WORDS: Record<LoopLevel, string> = {
  ask: 'Ask first',
  auto: 'On its own',
  deny: 'Never',
}
const RUN_DOTS: Record<LoopRunView['status'], string> = {
  running: 'running',
  waiting_person: 'waiting',
  waiting_event: 'pending',
  done: 'done',
  failed: 'failed',
}

/** "Active · 46 runs this week · 91% unattended". */
function statusLine(p: LoopInstallationView) {
  return [
    STATUS_WORDS[p.status],
    `${p.runsThisWeek} run${p.runsThisWeek === 1 ? '' : 's'} this week`,
    p.unattended !== null && `${Math.round(p.unattended * 100)}% unattended`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function AppLogos({ apps }: { apps: { kind: string }[] }) {
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {apps.slice(0, 4).map((a) => (
        <span key={a.kind} className="grid size-7 place-items-center rounded-full border bg-card">
          <ProviderLogo kind={a.kind as ProviderKind} className="size-4" />
        </span>
      ))}
    </span>
  )
}

function PlaybookRow({
  playbook: p,
  showProject,
}: {
  playbook: LoopInstallationView
  showProject: boolean
}) {
  return (
    <li>
      <Link
        href={`/app/automations/playbooks/${p.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted"
      >
        <AppLogos apps={p.apps} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{p.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot status={STATUS_DOTS[p.status]} className="size-1.5" />
            <span className="truncate">{statusLine(p)}</span>
          </span>
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          {showProject && <ProjectTag project={p.project} />}
          <TeammateAvatar teammate={p.teammate} className="size-4" />
          {p.teammate.name}
        </span>
      </Link>
    </li>
  )
}

/** Playbooks: whole jobs installed in the workspace, above the schedules. In a project, its own. */
export function PlaybookList({ projectId, filter }: { projectId?: string; filter?: string }) {
  const playbooks = useApi<LoopInstallationView[]>(`/loops${projectQuery(projectId ?? filter)}`)
  const catalog = useApi<LoopTemplate[]>('/loops/catalog')
  const reload = playbooks.reload
  useLive((message) => {
    if (message.type === 'thread.updated' || message.type === 'schedule.updated') void reload()
  })
  const list = playbooks.data ?? []
  const available = (catalog.data ?? []).filter((t) => !list.some((p) => p.loopKey === t.id))

  return (
    <section aria-labelledby="playbooks" className="flex flex-col gap-3">
      <h2 id="playbooks" className="flex items-center gap-2 text-sm font-bold">
        <BookOpenCheck className="size-4 text-muted-foreground" aria-hidden />
        Playbooks
      </h2>
      {!playbooks.data ? (
        <Skeleton className="h-16 w-full" />
      ) : list.length > 0 ? (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl bg-muted/60">
          {list.map((p) => (
            <PlaybookRow key={p.id} playbook={p} showProject={!projectId} />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No playbooks yet. A playbook is a whole job (support, releases…) a teammate runs on its
          own.
        </p>
      )}
      {list.length === 0 && available.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {available.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <AppLogos apps={t.apps} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.description}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {playbooks.error && (
        <p className="text-sm text-destructive-text">{playbooks.error.message}</p>
      )}
    </section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col divide-y rounded-xl bg-muted/60">{children}</div>
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm">{children}</div>
}

function ActionRow({ action: a }: { action: LoopActionView }) {
  const decided = a.approved + a.denied
  return (
    <Row>
      <span className="min-w-0 flex-1 truncate">{a.label}</span>
      {decided > 0 && (
        <span className="font-mono text-xs text-muted-foreground">
          {a.approved}/{decided} approved
        </span>
      )}
      <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium">
        {LEVEL_WORDS[a.level]}
      </span>
    </Row>
  )
}

/** A playbook's sheet: its state, actions, entries, settings and recent runs. */
export function PlaybookSheet({ id }: { id: string }) {
  const router = useRouter()
  const { me } = useDashboard()
  const playbook = useApi<LoopInstallationView>(`/loops/${id}`)
  const reload = playbook.reload
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  useLive((message) => {
    if (message.type === 'thread.updated' || message.type === 'schedule.updated') void reload()
  })

  if (playbook.error)
    return <p className="text-sm text-destructive-text">{playbook.error.message}</p>
  const p = playbook.data
  if (!p) return <Skeleton className="h-64 w-full" />
  const manages = p.owner.id === me.memberId || isAdmin(me)
  const waiting = p.status === 'setup' || p.status === 'dry_run'

  async function act(init: { method: string; body?: unknown }) {
    setError(undefined)
    try {
      await api(`/loops/${id}`, init)
      if (init.method === 'DELETE') router.push('/app/automations')
      else await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href="/app/automations"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Automations
      </Link>

      <header className="flex items-start gap-4">
        <AppLogos apps={p.apps} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-extrabold tracking-tight">{p.name}</h1>
          <p className="text-sm text-muted-foreground">
            {p.source === 'brigade' ? 'Brigade' : p.source} · v{p.version}
          </p>
          <p className="flex items-center gap-1.5 text-sm">
            <StatusDot status={STATUS_DOTS[p.status]} />
            {statusLine(p)}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <TeammateAvatar teammate={p.teammate} className="size-4" />
              <span className="font-medium text-foreground">{p.teammate.name}</span>
            </span>
            <span>on {p.owner.id === me.memberId ? 'your' : `${p.owner.name}'s`} accounts</span>
            <ProjectTag project={p.project} />
          </p>
        </div>
        {confirm ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="destructive" onClick={() => void act({ method: 'DELETE' })}>
              Uninstall
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More" disabled={!manages}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {p.status === 'active' ? (
                <DropdownMenuItem
                  onSelect={() => void act({ method: 'PATCH', body: { paused: true } })}
                >
                  <Pause aria-hidden />
                  Pause
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={waiting && !isAdmin(me)}
                  onSelect={() => void act({ method: 'PATCH', body: { paused: false } })}
                >
                  <Play aria-hidden />
                  {waiting ? 'Activate' : 'Resume'}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                <Trash2 aria-hidden />
                Uninstall
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      {confirm && (
        <p className="-mt-3 text-sm text-muted-foreground">
          Its triggers, schedules and skills go with it. Runs nobody took part in leave Threads.
        </p>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <p className="text-sm">{p.description}</p>

      {p.actions.length > 0 && (
        <Section title="Actions">
          {p.actions.map((a) => (
            <ActionRow key={a.key} action={a} />
          ))}
        </Section>
      )}

      <Section title="Entries">
        {p.entries.map((e) =>
          e.kind === 'trigger' ? (
            <Row key={e.id}>
              <ProviderLogo kind={e.app as ProviderKind} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              {e.account && (
                <span className="truncate text-xs text-muted-foreground">{e.account}</span>
              )}
            </Row>
          ) : (
            <Row key={e.id}>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {describeCron(e.cron)} ({zoneName(e.timezone)})
                {e.nextRunAt && ` · next ${scheduleTime(e.nextRunAt, e.timezone)}`}
              </span>
            </Row>
          ),
        )}
      </Section>

      {p.settings.length > 0 && (
        <Section title="Settings">
          {p.settings.map((s) => (
            <Row key={s.key}>
              <span className="min-w-0 flex-1 truncate">{s.ask ?? s.key}</span>
              <span className="max-w-[50%] truncate text-muted-foreground">
                {s.value === null ? '—' : String(s.value)}
              </span>
            </Row>
          ))}
        </Section>
      )}

      <Section title="Recent runs">
        {p.recentRuns.length === 0 ? (
          <Row>
            <span className="text-muted-foreground">No runs yet.</span>
          </Row>
        ) : (
          p.recentRuns.map((r) => {
            const body = (
              <>
                <StatusDot status={RUN_DOTS[r.status]} />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                {r.case && <span className="text-xs text-muted-foreground">{r.case}</span>}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(r.startedAt)}
                </span>
              </>
            )
            return r.threadId ? (
              <Link
                key={r.id}
                href={`/app/threads/${r.threadId}`}
                className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted"
              >
                {body}
              </Link>
            ) : (
              <Row key={r.id}>{body}</Row>
            )
          })
        )}
      </Section>
    </div>
  )
}
