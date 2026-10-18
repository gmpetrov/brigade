'use client'
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Check,
  ExternalLink,
  GitPullRequest,
  ListPlus,
  Pencil,
  RotateCcw,
  SquareKanban,
  Trash2,
  Undo2,
  UserRoundCog,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { StatusBadge, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { Markdown } from '@/components/markdown'
import { ProjectSelect } from '@/components/projects'
import type { StatusTone } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  api,
  harnessLabel,
  teammateModelLabel,
  pullHref,
  useApi,
  type Account,
  type Task,
  type TaskColumn,
  type TaskDetail,
  type TaskPriority,
  type Teammate,
} from '@/lib/api'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

export const COLUMNS: { id: TaskColumn; label: string; tone: StatusTone; empty: string }[] = [
  {
    id: 'backlog',
    label: 'Backlog',
    tone: 'neutral',
    empty: 'Nothing waiting. Assign a task to a teammate and it starts.',
  },
  {
    id: 'needs_you',
    label: 'Needs you',
    tone: 'warning',
    empty: 'Nothing is waiting on a person.',
  },
  { id: 'doing', label: 'Doing', tone: 'progress', empty: 'No task in progress.' },
  { id: 'done', label: 'Done', tone: 'success', empty: 'Finished tasks land here.' },
]

export const PRIORITIES: { id: TaskPriority; label: string; tone: StatusTone }[] = [
  { id: 'urgent', label: 'Urgent', tone: 'destructive' },
  { id: 'high', label: 'High', tone: 'warning' },
  { id: 'medium', label: 'Medium', tone: 'neutral' },
  { id: 'low', label: 'Low', tone: 'neutral' },
]

/** Higher first. */
export const priorityRank = (p: TaskPriority) =>
  PRIORITIES.length - PRIORITIES.findIndex((x) => x.id === p)

/**
 * A mission's column, from its own thread and its tasks: Needs you while any
 * of them waits on a person, Done once it is (the API marks it done with its
 * last task), Backlog while nothing has started.
 */
export function missionColumn(mission: Task, children: Task[]): TaskColumn {
  if (mission.column === 'needs_you' || children.some((c) => c.column === 'needs_you'))
    return 'needs_you'
  if (mission.completedAt) return 'done'
  if (!mission.thread && children.every((c) => c.column === 'backlog')) return 'backlog'
  return 'doing'
}

/** The status dot of a column, as on the board's column headers. */
export function ColumnDot({ column, className }: { column: TaskColumn; className?: string }) {
  const tone = COLUMNS.find((c) => c.id === column)!.tone
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'warning' && 'bg-warning',
        tone === 'progress' && 'bg-primary',
        tone === 'success' && 'bg-success',
        tone === 'neutral' && 'bg-muted-foreground',
        className,
      )}
    />
  )
}

export function ColumnBadge({ column }: { column: TaskColumn }) {
  const c = COLUMNS.find((x) => x.id === column)!
  return <StatusBadge status={column} tone={c.tone} label={c.label} />
}

/** Why a task is in Needs you, and where to act on it. */
function NeedsYouNote({
  task,
  thread,
}: {
  task: TaskDetail
  thread: NonNullable<TaskDetail['thread']>
}) {
  const open = task.pullRequests.filter((p) => p.state === 'open')
  const waiting = thread.openTickets > 0 || thread.status === 'waiting'
  const [pull] = open
  return (
    <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
      {thread.openTickets > 0
        ? `${thread.openTickets} open ticket${thread.openTickets > 1 ? 's' : ''} on its thread.`
        : thread.status === 'waiting'
          ? 'Its thread is waiting for an approval.'
          : open.length > 1
            ? `${open.length} pull requests are waiting for review. Merging them marks the task done.`
            : pull
              ? `Pull request #${pull.number} is waiting for review. Merging it marks the task done.`
              : task.pullRequests.some((p) => p.state === 'merged')
                ? 'Its pull request is merged. Mark it done, or say in the thread what is left.'
                : `${task.teammate?.name ?? 'Its teammate'} stopped at a pull request that was closed without merging.`}{' '}
      {!waiting && pull && open.length === 1 ? (
        <Link href={pullHref(pull.repository, pull.number)} className="font-semibold underline">
          Review it
        </Link>
      ) : (
        <Link href={`/app/threads/${thread.id}`} className="font-semibold underline">
          {waiting ? 'Answer in the thread' : 'Open the thread'}
        </Link>
      )}
    </p>
  )
}

/** Medium and low stay quiet; only high and urgent stand out. */
export function PriorityBadge({ priority, quiet }: { priority: TaskPriority; quiet?: boolean }) {
  const p = PRIORITIES.find((x) => x.id === priority)!
  if (quiet && (priority === 'medium' || priority === 'low')) return null
  return <StatusBadge status={priority} tone={p.tone} label={p.label} />
}

function PrioritySelect({
  value,
  onChange,
  id,
}: {
  value: TaskPriority
  onChange: (p: TaskPriority) => void
  id?: string
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TaskPriority)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** TeammateSelect's value for no teammate. */
const NOBODY = 'nobody'

function TeammateSelect({
  teammates,
  value,
  onChange,
  unavailable,
  nobody,
  id,
}: {
  teammates: Pick<Teammate, 'id' | 'name' | 'harness' | 'model'>[]
  value: string | undefined
  onChange: (id: string) => void
  /** Why a teammate cannot take it, if it cannot. */
  unavailable?: (t: Pick<Teammate, 'id' | 'name' | 'harness' | 'model'>) => string | undefined
  /** Offer "Nobody yet" (the value NOBODY): the task waits in Backlog. */
  nobody?: boolean
  id?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose a teammate" />
      </SelectTrigger>
      <SelectContent>
        {nobody && (
          <SelectItem value={NOBODY}>
            Nobody yet
            <span className="text-xs text-muted-foreground">Backlog</span>
          </SelectItem>
        )}
        {teammates.map((t) => {
          const why = unavailable?.(t)
          return (
            <SelectItem key={t.id} value={t.id} disabled={Boolean(why)}>
              <TeammateAvatar teammate={t} className="size-5" />
              {t.name}
              <span className="text-xs text-muted-foreground">{why ?? teammateModelLabel(t)}</span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

const LAST_CHOICE = 'brigade.tasks.new'

/** The assignee and priority of the last task made by hand, remembered per browser. */
function lastChoice(): { teammateId?: string; priority?: TaskPriority } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_CHOICE) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/**
 * A new task: with a teammate, its thread starts at once; with nobody, it
 * waits in Backlog. Or from a thread, which becomes the task's thread (its
 * teammate is whoever answered it last).
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onCreated,
  from,
  projectId: initialProject,
  mission,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (task: TaskDetail) => void
  /** From a thread: the task takes the thread's project. */
  from?: { sessionId: string; title: string }
  /** The project it starts in, e.g. from a project page. */
  projectId?: string
  /** The mission it goes in, which it takes the project of; a task of its own becomes one. */
  mission?: { id: string; title: string; isMission: boolean }
}) {
  const { teammates, projects } = useDashboard()
  const [projectId, setProjectId] = useState(initialProject ?? 'none')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [teammateId, setTeammateId] = useState<string>(NOBODY)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // By hand, the last task's assignee and priority again; from a thread, the defaults.
  useEffect(() => {
    if (!open) return
    const last = from ? {} : lastChoice()
    setTitle(from?.title ?? '')
    setDescription('')
    setPriority(PRIORITIES.some((p) => p.id === last.priority) ? last.priority! : 'medium')
    setTeammateId(last.teammateId ?? NOBODY)
    setProjectId(initialProject ?? 'none')
    setError(undefined)
  }, [open, from?.title, initialProject])

  const assignee =
    teammateId !== NOBODY && teammates.some((t) => t.id === teammateId) ? teammateId : undefined

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const task = await api<TaskDetail>('/tasks', {
        body: {
          title,
          description,
          priority,
          ...(from ? { sessionId: from.sessionId } : assignee ? { teammateId: assignee } : {}),
          ...(from || mission ? {} : { projectId: projectId === 'none' ? null : projectId }),
          ...(mission ? { parentId: mission.id } : {}),
        },
      })
      if (!from)
        try {
          localStorage.setItem(
            LAST_CHOICE,
            JSON.stringify({ teammateId: assignee ?? NOBODY, priority }),
          )
        } catch {}
      onOpenChange(false)
      onCreated(task)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {from
                ? 'Make this thread a task'
                : mission
                  ? `New task in “${mission.title}”`
                  : 'New task'}
            </DialogTitle>
            <DialogDescription>
              {from
                ? 'It goes on the Tasks board, and this thread becomes its thread.'
                : mission && !mission.isMission
                  ? 'This task becomes a mission: one card on the board for its tasks, done when they all are.'
                  : assignee
                    ? 'The teammate starts on it right away, with the title and description as the first message of its thread.'
                    : 'It waits in Backlog. Assign it to a teammate when you want it started.'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Title" htmlFor="task-title">
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add CSV export to the billing page"
              required
              maxLength={200}
              autoFocus
            />
          </Field>
          <Field label="What done looks like" htmlFor="task-description">
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="max-h-64"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" htmlFor="task-priority">
              <PrioritySelect id="task-priority" value={priority} onChange={setPriority} />
            </Field>
            {!from && (
              <Field label="Assignee" htmlFor="task-teammate">
                <TeammateSelect
                  id="task-teammate"
                  teammates={teammates}
                  value={assignee ?? NOBODY}
                  onChange={setTeammateId}
                  nobody
                />
              </Field>
            )}
          </div>
          {!from && !mission && projects.some((p) => !p.archivedAt) && (
            <Field label="Project" htmlFor="task-project">
              <ProjectSelect
                id="task-project"
                value={projectId}
                onChange={setProjectId}
                className="sm:w-full"
              />
            </Field>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy
                ? 'Creating…'
                : from
                  ? 'Make it a task'
                  : assignee
                    ? 'Create and start'
                    : 'Add to Backlog'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A teammate takes the task. In Backlog, its thread starts right away. With a
 * thread, the teammate joins it and is told why and where the work so far is;
 * it does not see the previous one's files.
 */
export function AssignDialog({
  task,
  open,
  onOpenChange,
  onDone,
}: {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const { me, teammates } = useDashboard()
  const thread = task.thread
  // The thread runs on its starter's accounts; only the starter's own are visible here.
  const accounts = useApi<Account[]>(
    open && thread && thread.startedByMemberId === me.memberId ? '/accounts' : null,
  )
  const [teammateId, setTeammateId] = useState<string>()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTeammateId(undefined)
    setReason('')
    setError(undefined)
  }, [open])

  const others = teammates.filter((t) => t.id !== task.teammate?.id)
  const unavailable = (t: Pick<Teammate, 'harness'>) => {
    if (!thread || !accounts.data) return undefined
    const ok = accounts.data.some(
      (a) =>
        a.computer.id === thread.computerId &&
        a.provider === t.harness &&
        (a.status === 'ready' || a.status === 'unverified') &&
        !(a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()),
    )
    return ok ? undefined : `No ${harnessLabel(t.harness)} account on that computer`
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !teammateId) return
    setBusy(true)
    setError(undefined)
    try {
      await api(`/tasks/${task.id}/assign`, { body: { teammateId, reason } })
      onOpenChange(false)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {thread ? 'Reassign' : 'Assign'} “{task.title}”
            </DialogTitle>
            <DialogDescription>
              {thread
                ? `The new teammate joins the thread and picks up from ${task.teammate?.name ?? 'the previous one'}: it reads the conversation, your reason, and what was pushed or attached. It does not see the previous teammate's working folder.`
                : 'The teammate starts on it right away, with the title and description as the first message of its thread, on the cloud computer or else your own.'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Give it to" htmlFor="reassign-teammate">
            <TeammateSelect
              id="reassign-teammate"
              teammates={others}
              value={teammateId}
              onChange={setTeammateId}
              unavailable={unavailable}
            />
          </Field>
          {thread && (
            <Field label="What should change?" htmlFor="reassign-reason">
              <Textarea
                id="reassign-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="max-h-48"
                placeholder="The export misses refunded payments. Start again from the billing service."
              />
            </Field>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !teammateId}>
              {busy
                ? thread
                  ? 'Reassigning…'
                  : 'Starting…'
                : thread
                  ? 'Reassign'
                  : 'Assign and start'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A task beside the board: details, edits and what to do next. */
export function TaskSheet({
  taskId,
  onClose,
  onChanged,
  onOpenTask,
}: {
  taskId: string | null
  onClose: () => void
  onChanged: () => void
  /** Open another task in the sheet: a mission's task, or a task's mission. */
  onOpenTask: (id: string) => void
}) {
  const { projects } = useDashboard()
  const detail = useApi<TaskDetail>(taskId ? `/tasks/${taskId}` : null)
  const task = detail.data?.id === taskId ? detail.data : undefined
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    setEditing(false)
    setConfirmDelete(false)
    setError(undefined)
  }, [taskId])

  // The board refetches on live updates; so does the open task.
  const reload = detail.reload
  useEffect(() => {
    if (taskId) void reload()
  }, [taskId, reload])

  async function act(path: string, init: { method?: string; body?: unknown } = {}) {
    setError(undefined)
    try {
      await api(`/tasks/${taskId}${path}`, { method: 'POST', body: {}, ...init })
      await detail.reload()
      onChanged()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }

  return (
    <Sheet open={Boolean(taskId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        {!task ? (
          <SheetHeader>
            <SheetTitle className="sr-only">Task</SheetTitle>
            <p className="text-sm text-muted-foreground">{detail.error?.message ?? 'Loading…'}</p>
          </SheetHeader>
        ) : (
          <>
            <SheetHeader className="gap-3 border-b pr-12">
              <div className="flex flex-wrap items-center gap-2">
                {/* Archived unfinished, with its thread: it waits on nobody until it is back. */}
                {(!task.archivedAt || task.completedAt) && (
                  <ColumnBadge
                    column={task.children.length ? missionColumn(task, task.children) : task.column}
                  />
                )}
                {task.archivedAt && (
                  <StatusBadge status="archived" tone="neutral" label="Archived" />
                )}
                {task.trashedAt && (
                  <StatusBadge status="trashed" tone="neutral" label="In the Trash" />
                )}
                <PriorityBadge priority={task.priority} quiet />
              </div>
              {editing ? (
                <Input
                  aria-label="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  className="text-base font-bold"
                />
              ) : (
                <SheetTitle className="text-xl leading-snug font-extrabold tracking-tight">
                  {task.title}
                </SheetTitle>
              )}
              <SheetDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {task.teammate ? (
                  <>
                    <TeammateAvatar teammate={task.teammate} className="size-5" />
                    <Link
                      href={`/app/teammates/${task.teammate.id}`}
                      className="font-semibold text-foreground hover:underline"
                    >
                      {task.teammate.name}
                    </Link>
                  </>
                ) : (
                  <span className="font-semibold text-foreground">Nobody yet</span>
                )}
                <span aria-hidden>·</span>
                <span>
                  {task.createdByTeammate
                    ? `added by ${task.createdByTeammate.name} for ${task.createdBy.user.name}`
                    : `asked by ${task.createdBy.user.name}`}{' '}
                  {timeAgo(task.createdAt)}
                </span>
              </SheetDescription>
              {task.parent && (
                <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  In mission
                  <button
                    type="button"
                    onClick={() => onOpenTask(task.parent!.id)}
                    className="min-w-0 truncate font-semibold text-foreground hover:underline"
                  >
                    {task.parent.title}
                  </button>
                </p>
              )}
            </SheetHeader>

            <div className="flex flex-col gap-6 p-4">
              <div className="flex flex-wrap gap-2">
                {task.trashedAt ? (
                  <Button size="sm" onClick={() => void act('/restore')}>
                    <Undo2 aria-hidden />
                    Restore
                  </Button>
                ) : task.thread ? (
                  <Button asChild size="sm">
                    <Link href={`/app/threads/${task.thread.id}`}>
                      Open thread
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setAssigning(true)}>
                    <UserRoundCog aria-hidden />
                    Assign
                  </Button>
                )}
                {!task.trashedAt && task.thread && !task.completedAt && (
                  <Button size="sm" variant="outline" onClick={() => void act('/complete')}>
                    <Check aria-hidden />
                    Mark done
                  </Button>
                )}
                {!task.trashedAt && task.completedAt && (
                  <Button size="sm" variant="outline" onClick={() => void act('/reopen')}>
                    <RotateCcw aria-hidden />
                    Reopen
                  </Button>
                )}
                {/* A mission's task is archived with its mission. */}
                {!task.trashedAt && task.completedAt && !task.archivedAt && !task.parentId && (
                  <Button size="sm" variant="outline" onClick={() => void act('/archive')}>
                    <Archive aria-hidden />
                    Archive
                  </Button>
                )}
                {!task.trashedAt && task.archivedAt && (
                  <Button size="sm" variant="outline" onClick={() => void act('/unarchive')}>
                    <ArchiveRestore aria-hidden />
                    Unarchive
                  </Button>
                )}
                {!task.trashedAt && task.thread && (
                  <Button size="sm" variant="outline" onClick={() => setAssigning(true)}>
                    <UserRoundCog aria-hidden />
                    Reassign
                  </Button>
                )}
                {!task.trashedAt && !task.archivedAt && !task.parentId && (
                  <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                    <ListPlus aria-hidden />
                    Add a task
                  </Button>
                )}
              </div>

              {task.children.length > 0 && (
                <MissionTasks tasks={task.children} onOpen={onOpenTask} />
              )}

              {!task.trashedAt &&
                !task.archivedAt &&
                task.thread &&
                task.column === 'needs_you' && <NeedsYouNote task={task} thread={task.thread} />}

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">Description</h3>
                  {!editing && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setTitle(task.title)
                        setDescription(task.description)
                        setEditing(true)
                      }}
                    >
                      <Pencil aria-hidden />
                      Edit
                    </Button>
                  )}
                </div>
                {editing ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void act('', { method: 'PATCH', body: { title, description } }).then(
                        (ok) => ok && setEditing(false),
                      )
                    }}
                  >
                    <Textarea
                      aria-label="Description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={6}
                      className="max-h-96"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(false)}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" disabled={!title.trim()}>
                        Save
                      </Button>
                    </div>
                  </form>
                ) : task.description ? (
                  <div className="text-sm">
                    <Markdown text={task.description} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No description.</p>
                )}
              </section>

              <div className="flex flex-wrap gap-x-8 gap-y-4">
                <section className="flex flex-col gap-2">
                  <Label htmlFor="sheet-priority" className="text-sm font-bold">
                    Priority
                  </Label>
                  <div className="w-48">
                    <PrioritySelect
                      id="sheet-priority"
                      value={task.priority}
                      onChange={(priority) => void act('', { method: 'PATCH', body: { priority } })}
                    />
                  </div>
                </section>
                {!task.parentId && (projects.length > 0 || task.projectId) && (
                  <section className="flex flex-col gap-2">
                    <Label htmlFor="sheet-project" className="text-sm font-bold">
                      Project
                    </Label>
                    <ProjectSelect
                      id="sheet-project"
                      value={task.projectId ?? 'none'}
                      onChange={(value) =>
                        void act('', {
                          method: 'PATCH',
                          body: { projectId: value === 'none' ? null : value },
                        })
                      }
                    />
                  </section>
                )}
                {!task.trashedAt && task.children.length === 0 && (
                  <MissionSelect
                    task={task}
                    onChange={(parentId) => void act('', { method: 'PATCH', body: { parentId } })}
                  />
                )}
              </div>

              {(task.summary || task.deliverables.length > 0 || task.pullRequests.length > 0) && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-bold">
                    {task.completedAt ? 'Delivered' : 'Work so far'}
                  </h3>
                  {task.summary && (
                    <div className="text-sm">
                      <Markdown text={task.summary} />
                    </div>
                  )}
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {task.pullRequests.map((p) => (
                      <li key={p.id} className="flex items-center gap-2">
                        <GitPullRequest
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <Link
                          href={pullHref(p.repository, p.number)}
                          className="truncate hover:underline"
                        >
                          {p.repository}#{p.number} {p.title}
                        </Link>
                        <StatusBadge
                          status={p.state}
                          tone={p.state === 'merged' ? 'success' : 'neutral'}
                        />
                      </li>
                    ))}
                    {task.deliverables.map((d) => (
                      <li key={d.url} className="flex items-center gap-2">
                        <ExternalLink
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate hover:underline"
                        >
                          {d.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {error && <p className="text-sm text-destructive-text">{error}</p>}

              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                {!task.trashedAt ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => void act('/trash').then((ok) => ok && onClose())}
                  >
                    <Trash2 aria-hidden />
                    Move to Trash
                  </Button>
                ) : confirmDelete ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      Delete it for good?{task.thread ? ' Its thread stays.' : ''}
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        void act('', { method: 'DELETE', body: undefined }).then(
                          (ok) => ok && onClose(),
                        )
                      }
                    >
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 aria-hidden />
                    Delete for good
                  </Button>
                )}
              </div>
            </div>

            <AssignDialog
              task={task}
              open={assigning}
              onOpenChange={setAssigning}
              onDone={() => {
                void detail.reload()
                onChanged()
              }}
            />
            <NewTaskDialog
              open={adding}
              onOpenChange={setAdding}
              mission={{ id: task.id, title: task.title, isMission: task.children.length > 0 }}
              onCreated={() => {
                void detail.reload()
                onChanged()
              }}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** A mission's tasks in its sheet: where each stands, and who is on it. */
function MissionTasks({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  // One archived unfinished, with its thread, no longer counts toward the mission.
  const counted = tasks.filter((t) => t.completedAt || !t.archivedAt)
  const done = counted.filter((t) => t.completedAt).length
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        Tasks
        <span className="font-mono text-xs font-normal text-muted-foreground">
          {done}/{counted.length}
        </span>
      </h3>
      <ul className="flex flex-col divide-y rounded-lg border">
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onOpen(t.id)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                t.column === 'needs_you' && !t.archivedAt && 'bg-warning/10',
                t.archivedAt && !t.completedAt && 'text-muted-foreground',
              )}
            >
              {t.archivedAt && !t.completedAt ? (
                <Archive className="size-3.5 shrink-0" aria-label="Archived" />
              ) : (
                <ColumnDot column={t.column} />
              )}
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.teammate ? (
                <TeammateAvatar teammate={t.teammate} className="size-5" />
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">Unassigned</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

const NO_MISSION = 'none'

/**
 * The mission a task is in, among the tasks of its project on the board that
 * are not in a mission themselves. None: a task of its own.
 */
function MissionSelect({
  task,
  onChange,
}: {
  task: TaskDetail
  onChange: (parentId: string | null) => void
}) {
  const board = useApi<Task[]>(`/tasks?project=${task.projectId ?? 'none'}`)
  const missions = (board.data ?? []).filter(
    (t) => t.id !== task.id && !t.parentId && !t.archivedAt && !t.trashedAt,
  )
  if (!task.parentId && board.data && missions.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor="sheet-mission" className="text-sm font-bold">
        Mission
      </Label>
      <Select
        value={task.parentId ?? NO_MISSION}
        onValueChange={(v) => onChange(v === NO_MISSION ? null : v)}
      >
        <SelectTrigger id="sheet-mission" className="w-full sm:w-56">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_MISSION}>None</SelectItem>
          {task.parent && !missions.some((m) => m.id === task.parentId) && (
            <SelectItem value={task.parent.id}>{task.parent.title}</SelectItem>
          )}
          {missions.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              <span className="truncate">{m.title}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  )
}

/** "Make this a task", in a thread's header. */
export function MakeTaskButton({
  thread,
  onCreated,
}: {
  thread: { id: string; title: string }
  onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <SquareKanban aria-hidden />
        Make a task
      </Button>
      <NewTaskDialog
        open={open}
        onOpenChange={setOpen}
        from={{ sessionId: thread.id, title: thread.title }}
        onCreated={onCreated}
      />
    </>
  )
}

/** Above a task's thread: which task, where it stands, and what to do with it. */
export function ThreadTaskBar({
  taskId,
  status,
  onChanged,
}: {
  taskId: string
  /** The thread's status: a change can move the task between columns. */
  status: string
  onChanged: () => void
}) {
  const detail = useApi<TaskDetail>(`/tasks/${taskId}`)
  const [reassigning, setReassigning] = useState(false)
  const [error, setError] = useState<string>()
  const reload = detail.reload
  // On a new status: it loaded with the first.
  const loadedAt = useRef(status)
  useEffect(() => {
    if (loadedAt.current === status) return
    loadedAt.current = status
    void reload()
  }, [status, reload])
  useLive((message) => {
    if (message.type === 'task.updated' && message.taskId === taskId) void reload()
  })

  const task = detail.data
  if (!task) return null

  async function act(path: string) {
    setError(undefined)
    try {
      await api(`/tasks/${taskId}${path}`, { method: 'POST', body: {} })
      await reload()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-2.5">
      <SquareKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-sm text-muted-foreground">Task</span>
      <Link
        href={`/app/tasks?task=${task.id}`}
        className="min-w-0 truncate text-sm font-semibold hover:underline"
      >
        {task.title}
      </Link>
      {task.parent && (
        <Link
          href={`/app/tasks?task=${task.parent.id}`}
          className="min-w-0 truncate text-sm text-muted-foreground hover:underline"
        >
          Mission · {task.parent.title}
        </Link>
      )}
      <ColumnBadge column={task.column} />
      <PriorityBadge priority={task.priority} quiet />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {error && <span className="text-sm text-destructive-text">{error}</span>}
        {/* Reopening and untracking a task are on the tasks board. */}
        {!task.completedAt && (
          <Button size="sm" variant="outline" onClick={() => void act('/complete')}>
            <Check aria-hidden />
            Mark done
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setReassigning(true)}>
          <UserRoundCog aria-hidden />
          Reassign
        </Button>
      </div>
      <AssignDialog
        task={task}
        open={reassigning}
        onOpenChange={setReassigning}
        onDone={() => {
          void reload()
          onChanged()
        }}
      />
    </div>
  )
}
