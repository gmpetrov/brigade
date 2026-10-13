'use client'
import {
  ArrowRight,
  Brain,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Inbox,
  Plug,
} from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { StatusBadge, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { useDocumentPanel } from '@/components/document-panel'
import { NewThread, useLastTeammate } from '@/components/new-thread'
import { useProject } from '@/components/project-shell'
import { PriorityBadge } from '@/components/tasks'
import { TicketRow } from '@/components/ticket-row'
import { Card } from '@/components/ui/card'
import {
  api,
  pullHref,
  useApi,
  type PullRequestList,
  type Task,
  type ThreadSummary,
  type Ticket,
} from '@/lib/api'
import { useLive } from '@/lib/use-live'

const ACTIVE = new Set(['starting', 'running', 'waiting'])

function Box({
  title,
  detail,
  href,
  children,
  className,
}: {
  title: string
  detail?: ReactNode
  href?: string
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={`gap-3 px-5 py-4 ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold">{title}</h2>
        {detail !== undefined && <span className="text-sm text-muted-foreground">{detail}</span>}
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
    </Card>
  )
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

/** What a project has going on, and a box to start a thread in it. */
export default function ProjectOverview() {
  const { project } = useProject()
  const { me, teammates } = useDashboard()
  const documents = useDocumentPanel()
  const base = `/app/projects/${project.id}`
  const threads = useApi<ThreadSummary[]>(`/threads?project=${project.id}`)
  const tickets = useApi<Ticket[]>(`/tickets?project=${project.id}`)
  const tasks = useApi<Task[]>(`/tasks?project=${project.id}`)
  const pulls = useApi<PullRequestList>(
    project.repositories.length > 0 ? `/pulls?state=open&project=${project.id}` : null,
  )
  const [chosen, choose] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === chosen) ?? teammates[0]
  useLive((message) => {
    if (message.type === 'tickets.updated') void tickets.reload()
    if (message.type === 'thread.updated') void threads.reload()
    if (message.type === 'task.updated' || message.type === 'thread.updated') void tasks.reload()
    if (message.type === 'pulls.updated') void pulls.reload()
  })

  async function resolve(id: string, approved: boolean, always?: boolean) {
    await api(`/tickets/${id}/resolve`, {
      body: { approved, ...(always ? { always } : {}) },
    }).catch(() => undefined)
    await tickets.reload()
  }

  const running = (threads.data ?? []).filter((t) => ACTIVE.has(t.status))
  const recent = (threads.data ?? []).filter((t) => !ACTIVE.has(t.status)).slice(0, 3)
  const openTasks = (tasks.data ?? []).filter((t) => t.column !== 'done')
  const open = tickets.data ?? []

  return (
    <div className="flex flex-col gap-6">
      {teammate && !project.archivedAt && (
        <NewThread
          teammate={teammate}
          rows={2}
          projectId={project.id}
          picker={teammates.length > 1 ? { teammates, onChange: choose } : undefined}
          placeholder={`Ask ${teammate.name} something for ${project.name}…`}
        />
      )}

      {open.length > 0 && (
        <Box title="Needs you" detail={`${open.length} open`}>
          <ul className="-mx-5 divide-y border-t">
            {open.slice(0, 5).map((t) => (
              <TicketRow key={t.id} ticket={t} me={me} onResolve={resolve} />
            ))}
          </ul>
          {open.length > 5 && (
            <Link href="/app/tickets" className="text-xs text-muted-foreground hover:underline">
              {open.length - 5} more on Tickets
            </Link>
          )}
        </Box>
      )}

      <Box
        title={running.length ? 'Running now' : 'Latest threads'}
        detail={running.length ? running.length : undefined}
        href={`${base}/threads`}
      >
        {threads.data && running.length + recent.length === 0 ? (
          <Quiet>No threads yet. Start one above.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1">
            {(running.length ? running : recent).map((t) => (
              <li key={t.id}>
                <Link
                  href={`/app/threads/${t.id}`}
                  className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50"
                >
                  <TeammateAvatar
                    teammate={
                      teammates.find((m) => m.id === t.teammate.id) ?? {
                        ...t.teammate,
                        harness: 'claude_code',
                      }
                    }
                    className="size-5"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {timeAgo(t.updatedAt)}
                  </span>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Box>

      <div className="grid gap-6 md:grid-cols-2">
        <Box title="Open tasks" detail={tasks.data ? openTasks.length : ''} href={`${base}/tasks`}>
          {tasks.data && openTasks.length === 0 ? (
            <Quiet>Nothing on the board.</Quiet>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {openTasks.slice(0, 5).map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <PriorityBadge priority={t.priority} quiet />
                  <Link
                    href={`${base}/tasks?task=${t.id}`}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {t.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t.teammate?.name ?? 'Unassigned'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Box>

        <Box
          title="Pull requests"
          detail={pulls.data ? `${pulls.data.pulls.length} open` : undefined}
          href={`${base}/pulls`}
        >
          {project.repositories.length === 0 ? (
            <Quiet>
              <Link href={`${base}/repos`} className="font-medium text-primary hover:underline">
                Add a repository
              </Link>{' '}
              to see its pull requests here.
            </Quiet>
          ) : pulls.data && pulls.data.pulls.length === 0 ? (
            <Quiet>None open.</Quiet>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {(pulls.data?.pulls ?? []).slice(0, 5).map((p) => (
                <li key={`${p.repository}#${p.number}`} className="flex items-center gap-2 text-sm">
                  <GitPullRequest className="size-4 shrink-0 text-success" aria-hidden />
                  <Link
                    href={pullHref(p.repository, p.number)}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {p.title}
                  </Link>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    #{p.number}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Box>
      </div>

      <Box
        title="Repos and previews"
        detail={project.repositories.length || undefined}
        href={`${base}/repos`}
      >
        {project.repositories.length === 0 ? (
          <Quiet>
            No repositories yet.{' '}
            <Link href={`${base}/repos`} className="font-medium text-primary hover:underline">
              Add one
            </Link>{' '}
            so its threads know where the code is.
          </Quiet>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {project.repositories.map((r) => (
              <li key={r.repository} className="flex flex-wrap items-center gap-2 text-sm">
                <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Link href={`/app/pulls/${r.repository}`} className="font-mono hover:underline">
                  {r.repository}
                </Link>
                {r.reachable === false && <StatusBadge status="failed" label="not reachable" />}
                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                  {r.preview ? `${r.preview.command} · :${r.preview.port}` : 'no saved preview'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Box>

      <div className="grid gap-6 md:grid-cols-2">
        <Box title="Context" detail="given to every thread in it" href={`${base}/settings`}>
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex items-center gap-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1">Brief</span>
              <span className="text-xs text-muted-foreground">
                {project.brief ? `${project.brief.length} characters` : 'none yet'}
              </span>
            </li>
            <li className="flex items-center gap-2">
              <Brain className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                className="flex-1 text-left hover:underline"
                onClick={() =>
                  documents.open({
                    target: { kind: 'project_memory', projectId: project.id },
                    title: `${project.name} memory`,
                    subtitle: 'Loaded by every thread in the project',
                  })
                }
              >
                Memory
              </button>
              <span className="text-xs text-muted-foreground">
                {project.memory ? `${project.memory.lines} lines` : 'empty'}
              </span>
            </li>
            {project.folder && (
              <li className="flex items-center gap-2">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Link href={`${base}/library`} className="min-w-0 flex-1 truncate hover:underline">
                  {project.folder}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {project.files} file{project.files === 1 ? '' : 's'}
                </span>
              </li>
            )}
            <li className="flex items-center gap-2">
              <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {project.preferredConnections.length
                  ? project.preferredConnections.map((c) => c.label).join(', ')
                  : 'No preferred connections'}
              </span>
            </li>
          </ul>
        </Box>

        <Box title="This week">
          <dl className="grid grid-cols-3 gap-3">
            {[
              { label: 'Working hours', value: project.week.workingHours },
              { label: 'Threads', value: project.week.threads },
              { label: 'PRs merged', value: project.week.merged },
            ].map((s) => (
              <div key={s.label} className="flex flex-col gap-0.5 rounded-lg bg-secondary/60 p-3">
                <dt className="text-xs text-muted-foreground">{s.label}</dt>
                <dd className="text-xl font-bold tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
        </Box>
      </div>

      {!teammate && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Inbox className="size-4" aria-hidden />
          Add an AI teammate to start threads in this project.
        </p>
      )}
    </div>
  )
}
