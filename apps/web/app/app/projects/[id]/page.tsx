'use client'
import type { ListSummary, PlaybookInstallationView } from '@brigade/contracts'
import { ArrowRight, Inbox } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { timeAgo, useDashboard } from '@/components/dashboard'
import { LIST_LIVE } from '@/components/list-items'
import { ListRow } from '@/components/list-row'
import { NewThread, useLastTeammate } from '@/components/new-thread'
import { useProject } from '@/components/project-shell'
import { describeCron } from '@/components/schedules'
import { StatusDot } from '@/components/status-badge'
import { Card } from '@/components/ui/card'
import { useApi, type Schedule, type Trigger } from '@/lib/api'

/** Lists shown before "All": the rest are on the Lists page. */
const LISTS_SHOWN = 4
/** Routines shown before "+N more". */
const ROUTINES_SHOWN = 5

function Section({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-[13.5px] font-bold">{title}</h2>
        {href && (
          <Link
            href={href}
            className="ml-auto flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            All
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
    {children}
  </p>
)

/** One thing that runs on its own: a dot for its health, its name, when it runs. */
type Routine = { key: string; status: string; name: string; when: string; href: string }

function routines(
  playbooks: PlaybookInstallationView[],
  schedules: Schedule[],
  triggers: Trigger[],
  /** Where a schedule that never ran yet leads: the project's routines. */
  routinesHref: string,
): Routine[] {
  return [
    ...playbooks.map((p) => ({
      key: `playbook:${p.id}`,
      status: p.status === 'active' ? 'active' : p.status === 'paused' ? 'paused' : 'pending',
      name: p.name,
      when: `${p.runsThisWeek} run${p.runsThisWeek === 1 ? '' : 's'} this week`,
      href: `/app/routines/playbooks/${p.id}`,
    })),
    ...schedules.map((s) => ({
      key: `schedule:${s.id}`,
      status: s.lastError ? 'failed' : s.pausedAt ? 'paused' : 'active',
      name: s.title,
      when: [describeCron(s.cron), s.lastRun && `ran ${timeAgo(s.lastRun.createdAt)}`]
        .filter(Boolean)
        .join(' · '),
      href: s.lastRun ? `/app/threads/${s.lastRun.id}` : routinesHref,
    })),
    ...triggers.map((t) => ({
      key: `trigger:${t.id}`,
      status: 'active',
      name: t.label,
      when: `on each event · ${t.teammate.name}`,
      href: '/app/connections',
    })),
  ]
}

/**
 * A project's page under its header: a box to start a thread in it, then how it moves along —
 * its lists and what runs on its own. What the sidebar, Home or the settings already show
 * (its threads, what needs a person, its context) is not repeated here.
 */
export default function ProjectOverview() {
  const { project } = useProject()
  const { teammates } = useDashboard()
  const all = useApi<ListSummary[]>('/lists', LIST_LIVE)
  const playbooks = useApi<PlaybookInstallationView[]>(`/playbooks?project=${project.id}`, [
    'thread.updated',
    'schedule.updated',
  ])
  const schedules = useApi<Schedule[]>(`/schedules?project=${project.id}`, [
    'schedule.updated',
    'thread.updated',
  ])
  const triggers = useApi<Trigger[]>(`/triggers?project=${project.id}`)
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]

  const lists = (all.data ?? []).filter((l) => l.projectId === project.id)
  // The lists something moves on; with none, the last changed (the API sends those first).
  const moving = lists.filter((l) => l.needsYou > 0 || l.inProgress > 0)
  const shownLists = (moving.length ? moving : lists).slice(0, LISTS_SHOWN)
  const routinesHref = `/app/routines?project=${project.id}`
  const running =
    playbooks.data && schedules.data && triggers.data
      ? routines(playbooks.data, schedules.data, triggers.data, routinesHref)
      : null

  const listsSection = all.data && (
    <Section key="lists" title="Lists" href={lists.length ? '/app/lists' : undefined}>
      {lists.length === 0 ? (
        <Quiet>
          No lists yet. A Markdown file with checkboxes
          {project.folder ? (
            <>
              {' in '}
              <Link
                href={`/app/library?folder=${encodeURIComponent(project.folder)}`}
                className="font-mono text-foreground hover:underline"
              >
                {project.folder}
              </Link>
            </>
          ) : null}{' '}
          shows here, and its lines can be handed to a teammate.
        </Quiet>
      ) : (
        <div className="overflow-hidden rounded-3xl border bg-card shadow-sm">
          {shownLists.map((list) => (
            <ListRow key={list.documentId} list={list} />
          ))}
        </div>
      )}
    </Section>
  )

  const routinesSection = running && (
    <Section key="routines" title="Runs on its own" href={routinesHref}>
      {running.length === 0 ? (
        <Quiet>
          Nothing runs on its own here yet. Ask a teammate for a routine, or add one on{' '}
          <Link href={routinesHref} className="font-medium text-primary hover:underline">
            Routines
          </Link>
          .
        </Quiet>
      ) : (
        <Card className="gap-0 py-1.5">
          <ul className="flex flex-col">
            {running.slice(0, ROUTINES_SHOWN).map((r) => (
              <li key={r.key}>
                <Link
                  href={r.href}
                  className="flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-accent/60"
                >
                  <StatusDot status={r.status} className="size-1.5" />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                  <span className="max-w-[55%] shrink-0 truncate text-xs text-muted-foreground">
                    {r.when}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {running.length > ROUTINES_SHOWN && (
            <Link
              href={routinesHref}
              className="px-4 pt-1 pb-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              +{running.length - ROUTINES_SHOWN} more
            </Link>
          )}
        </Card>
      )}
    </Section>
  )

  // What has something comes first: a project without lists leads with its routines.
  const listsFirst = lists.length > 0 || running?.length === 0

  return (
    <div className="flex flex-col gap-6">
      {teammate && !project.archivedAt && (
        <NewThread
          teammate={teammate}
          rows={2}
          typeToFocus
          openAtOnce
          giveBackHere
          projectId={project.id}
          picker={teammates.length > 1 ? { teammates, onChange: choose } : undefined}
          placeholder={`Ask ${teammate.name} something for ${project.name}…`}
        />
      )}

      {listsFirst ? [listsSection, routinesSection] : [routinesSection, listsSection]}

      {!teammate && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Inbox className="size-4" aria-hidden />
          Add an AI teammate to start threads in this project.
        </p>
      )}
    </div>
  )
}
