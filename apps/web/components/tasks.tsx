'use client'
import {
  ArrowRight,
  Check,
  ExternalLink,
  GitPullRequest,
  Pencil,
  Play,
  RotateCcw,
  SquareKanban,
  Trash2,
  UserRoundCog,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { StatusBadge, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { Markdown } from '@/components/markdown'
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
  computerName,
  harnessLabel,
  pullHref,
  usableComputers,
  useApi,
  type Account,
  type ComputersResponse,
  type Task,
  type TaskColumn,
  type TaskDetail,
  type TaskPriority,
  type Teammate,
} from '@/lib/api'
import { useLive } from '@/lib/use-live'

export const COLUMNS: { id: TaskColumn; label: string; tone: StatusTone; empty: string }[] = [
  { id: 'backlog', label: 'Backlog', tone: 'neutral', empty: 'Nothing waiting to start.' },
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

export function ColumnBadge({ column }: { column: TaskColumn }) {
  const c = COLUMNS.find((x) => x.id === column)!
  return <StatusBadge status={column} tone={c.tone} label={c.label} />
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

function TeammateSelect({
  teammates,
  value,
  onChange,
  unavailable,
  id,
}: {
  teammates: Pick<Teammate, 'id' | 'name' | 'harness'>[]
  value: string | undefined
  onChange: (id: string) => void
  /** Why a teammate cannot take it, if it cannot. */
  unavailable?: (t: Pick<Teammate, 'id' | 'name' | 'harness'>) => string | undefined
  id?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose a teammate" />
      </SelectTrigger>
      <SelectContent>
        {teammates.map((t) => {
          const why = unavailable?.(t)
          return (
            <SelectItem key={t.id} value={t.id} disabled={Boolean(why)}>
              <TeammateAvatar teammate={t} className="size-5" />
              {t.name}
              <span className="text-xs text-muted-foreground">
                {why ?? harnessLabel(t.harness)}
              </span>
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

/**
 * A new task: into Backlog by hand, or from a thread, which becomes the task's
 * thread (its teammate is whoever answered it last).
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onCreated,
  from,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (task: TaskDetail) => void
  from?: { sessionId: string; title: string }
}) {
  const { teammates } = useDashboard()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [teammateId, setTeammateId] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(from?.title ?? '')
    setDescription('')
    setPriority('medium')
    setError(undefined)
  }, [open, from?.title])

  const teammate = teammateId ?? teammates[0]?.id

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
          ...(from ? { sessionId: from.sessionId } : { teammateId: teammate }),
        },
      })
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
            <DialogTitle>{from ? 'Make this thread a task' : 'New task'}</DialogTitle>
            <DialogDescription>
              {from
                ? 'It goes on the Tasks board, and this thread becomes its thread.'
                : 'It goes into the backlog. Start it when you want a teammate on it.'}
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
              <Field label="Teammate" htmlFor="task-teammate">
                <TeammateSelect
                  id="task-teammate"
                  teammates={teammates}
                  value={teammate}
                  onChange={setTeammateId}
                />
              </Field>
            )}
          </div>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !title.trim() || (!from && !teammate)}>
              {busy ? 'Creating…' : from ? 'Make it a task' : 'Create task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A backlog task's thread starts on a computer, with its brief as the first message. */
export function StartTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const computers = useApi<ComputersResponse>(open ? '/computers' : null)
  const accounts = useApi<Account[]>(open ? '/accounts' : null)
  const [computerId, setComputerId] = useState<string>()
  const [accountId, setAccountId] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const online = usableComputers(computers.data)
  const computer = online.find((c) => c.id === computerId) ?? online[0]
  const usable = (accounts.data ?? []).filter(
    (a) =>
      a.computer.id === computer?.id &&
      a.provider === task.teammate.harness &&
      (a.status === 'ready' || a.status === 'unverified') &&
      !(a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()),
  )
  const account =
    usable.find((a) => a.id === accountId) ?? usable.find((a) => a.isDefault) ?? usable[0]
  const loaded = computers.data && accounts.data

  async function start(e: FormEvent) {
    e.preventDefault()
    if (busy || !computer || !account) return
    setBusy(true)
    setError(undefined)
    try {
      const started = await api<TaskDetail>(`/tasks/${task.id}/start`, {
        body: { computerId: computer.id, accountId: account.id },
      })
      onOpenChange(false)
      if (started.thread) router.push(`/app/threads/${started.thread.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void start(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Start “{task.title}”</DialogTitle>
            <DialogDescription>
              {task.teammate.name} gets the title and description as the first message of the
              task&apos;s thread.
            </DialogDescription>
          </DialogHeader>
          <Field label="Run on" htmlFor="start-computer">
            <Select value={computer?.id} onValueChange={setComputerId} disabled={!online.length}>
              <SelectTrigger id="start-computer" className="w-full">
                <SelectValue placeholder={loaded ? 'No computer is online' : 'Loading…'} />
              </SelectTrigger>
              <SelectContent>
                {online.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {computerName(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={`${harnessLabel(task.teammate.harness)} account`} htmlFor="start-account">
            <Select
              key={computer?.id}
              value={account?.id}
              onValueChange={setAccountId}
              disabled={!usable.length}
            >
              <SelectTrigger id="start-account" className="w-full">
                <SelectValue
                  placeholder={
                    loaded ? `No ${harnessLabel(task.teammate.harness)} account here` : 'Loading…'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {usable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                    {a.email ? ` (${a.email})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {loaded && computer && !account && (
            <p className="text-sm text-muted-foreground">
              Add a {harnessLabel(task.teammate.harness)} account on {computerName(computer)} under{' '}
              <Link href="/app/accounts" className="font-medium text-primary hover:underline">
                Accounts
              </Link>
              .
            </p>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !computer || !account}>
              {busy ? 'Starting…' : 'Start'}
              <ArrowRight aria-hidden />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Another teammate takes the task. With a thread, it joins it and is told why
 * and where the work so far is; it does not see the previous one's files.
 */
export function ReassignDialog({
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

  const others = teammates.filter((t) => t.id !== task.teammate.id)
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
      await api(`/tasks/${task.id}/reassign`, { body: { teammateId, reason } })
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
            <DialogTitle>Reassign “{task.title}”</DialogTitle>
            <DialogDescription>
              {thread
                ? `The new teammate joins the thread and picks up from ${task.teammate.name}: it reads the conversation, your reason, and what was pushed or attached. It does not see ${task.teammate.name}'s working folder.`
                : `${task.teammate.name} has not started it yet.`}
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
              {busy ? 'Reassigning…' : 'Reassign'}
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
}: {
  taskId: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useApi<TaskDetail>(taskId ? `/tasks/${taskId}` : null)
  const task = detail.data?.id === taskId ? detail.data : undefined
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dialog, setDialog] = useState<'start' | 'reassign'>()
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
                <ColumnBadge column={task.column} />
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
                <TeammateAvatar teammate={task.teammate} className="size-5" />
                <Link
                  href={`/app/teammates/${task.teammate.id}`}
                  className="font-semibold text-foreground hover:underline"
                >
                  {task.teammate.name}
                </Link>
                <span aria-hidden>·</span>
                <span>
                  asked by {task.createdBy.user.name} {timeAgo(task.createdAt)}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-6 p-4">
              <div className="flex flex-wrap gap-2">
                {task.thread ? (
                  <Button asChild size="sm">
                    <Link href={`/app/threads/${task.thread.id}`}>
                      Open thread
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setDialog('start')}>
                    <Play aria-hidden />
                    Start
                  </Button>
                )}
                {task.thread && !task.completedAt && (
                  <Button size="sm" variant="outline" onClick={() => void act('/complete')}>
                    <Check aria-hidden />
                    Mark done
                  </Button>
                )}
                {task.completedAt && (
                  <Button size="sm" variant="outline" onClick={() => void act('/reopen')}>
                    <RotateCcw aria-hidden />
                    Reopen
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setDialog('reassign')}>
                  <UserRoundCog aria-hidden />
                  Reassign
                </Button>
              </div>

              {task.thread && task.column === 'needs_you' && (
                <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                  {task.thread.openTickets > 0
                    ? `${task.thread.openTickets} open ticket${task.thread.openTickets > 1 ? 's' : ''} on its thread.`
                    : 'Its thread is waiting for an approval.'}{' '}
                  <Link href={`/app/threads/${task.thread.id}`} className="font-semibold underline">
                    Answer in the thread
                  </Link>
                </p>
              )}

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

              <section className="flex flex-col gap-2">
                <Label htmlFor="sheet-priority" className="text-sm font-bold">
                  Priority
                </Label>
                <div className="max-w-48">
                  <PrioritySelect
                    id="sheet-priority"
                    value={task.priority}
                    onChange={(priority) => void act('', { method: 'PATCH', body: { priority } })}
                  />
                </div>
              </section>

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
                {confirmDelete ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      Delete this task?{task.thread ? ' Its thread stays.' : ''}
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
                    Delete task
                  </Button>
                )}
              </div>
            </div>

            <StartTaskDialog
              task={task}
              open={dialog === 'start'}
              onOpenChange={(open) => setDialog(open ? 'start' : undefined)}
            />
            <ReassignDialog
              task={task}
              open={dialog === 'reassign'}
              onOpenChange={(open) => setDialog(open ? 'reassign' : undefined)}
              onDone={() => {
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
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string>()
  const reload = detail.reload
  useEffect(() => {
    void reload()
  }, [status, reload])
  useLive((message) => {
    if (message.type === 'task.updated' && message.taskId === taskId) void reload()
  })

  const task = detail.data
  if (!task) return null

  async function act(path: string, init: { method?: string; body?: unknown } = {}) {
    setError(undefined)
    try {
      await api(`/tasks/${taskId}${path}`, { method: 'POST', body: {}, ...init })
      if (init.method !== 'DELETE') await reload()
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
      <ColumnBadge column={task.column} />
      <PriorityBadge priority={task.priority} quiet />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {error && <span className="text-sm text-destructive-text">{error}</span>}
        {confirm ? (
          <>
            <span className="text-sm text-muted-foreground">
              Stop tracking it? The thread stays.
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void act('', { method: 'DELETE', body: undefined })}
            >
              Not a task
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <>
            {task.completedAt ? (
              <Button size="sm" variant="outline" onClick={() => void act('/reopen')}>
                <RotateCcw aria-hidden />
                Reopen
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void act('/complete')}>
                <Check aria-hidden />
                Mark done
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setReassigning(true)}>
              <UserRoundCog aria-hidden />
              Reassign
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setConfirm(true)}
            >
              Not a task
            </Button>
          </>
        )}
      </div>
      <ReassignDialog
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
