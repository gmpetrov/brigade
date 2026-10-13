'use client'
import { ArrowRight, Check, ChevronDown, FolderKanban, List, Monitor, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { AttachButton, UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { Composer } from '@/components/composer'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { StatusDot } from '@/components/status-badge'
import { ProjectIcon } from '@/components/projects'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  api,
  computerName,
  harnessLabel,
  teammateModelLabel,
  usableComputers,
  useApi,
  type Account,
  type ComputersResponse,
  type Teammate,
  type ThreadSummary,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const quietSelect =
  'h-8 border-transparent bg-transparent shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent/50'

/** What a teammate is doing, as a dot beside it: working, or waiting on a person. */
export type TeammateActivity = 'busy' | 'waiting'

const ACTIVITY: Record<TeammateActivity, { dot: string; label: string }> = {
  busy: { dot: 'bg-primary', label: 'Working' },
  waiting: { dot: 'bg-warning', label: 'Needs you' },
}

type RecentThreadActions = {
  onOpen: (teammateId: string, threadId: string) => void
  onAll: (teammateId: string) => void
  onNew: (teammateId: string) => void
}

/** A teammate's five latest active threads, loaded as its submenu opens; then all, or a new one. */
function RecentThreads({
  teammate,
  actions,
}: {
  teammate: Teammate
  actions: RecentThreadActions
}) {
  const threads = useApi<ThreadSummary[]>(
    `/threads?teammateId=${teammate.id}&limit=5&sort=activity`,
  )
  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        {teammate.name}&apos;s latest threads
      </DropdownMenuLabel>
      {!threads.data ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          {threads.error?.message ?? 'Loading…'}
        </p>
      ) : threads.data.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No threads yet.</p>
      ) : (
        threads.data.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => actions.onOpen(teammate.id, t.id)}>
            {/* What runs or waits shows its dot; the rest none. */}
            {t.status === 'idle' ? (
              <span className="size-2 shrink-0" />
            ) : (
              <StatusDot status={t.status} />
            )}
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(t.updatedAt)}</span>
          </DropdownMenuItem>
        ))
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => actions.onAll(teammate.id)}>
        <List aria-hidden /> All threads
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => actions.onNew(teammate.id)}>
        <Plus aria-hidden /> New thread
      </DropdownMenuItem>
    </>
  )
}

function ActivityDot({ activity }: { activity?: TeammateActivity }) {
  if (!activity) return null
  return (
    <span
      role="img"
      aria-label={ACTIVITY[activity].label}
      title={ACTIVITY[activity].label}
      className={cn('size-2 shrink-0 rounded-full', ACTIVITY[activity].dot)}
    />
  )
}

/**
 * Pick a teammate: who a new thread goes to (the lead; others join when the message
 * @mentions them), or whose threads the threads panel lists.
 */
export function TeammatePicker({
  teammates,
  value,
  onChange,
  heading = 'Send to',
  activity,
  recent,
  compact = false,
}: {
  teammates: Teammate[]
  value: Teammate
  onChange: (id: string) => void
  /** Above the list, and what the button says it changes. */
  heading?: string
  /** A dot beside each teammate that is working or waiting. */
  activity?: Record<string, TeammateActivity>
  /**
   * Each teammate opens its latest threads beside it, to go straight to one (or all of
   * them, or a new one) instead of only picking the teammate.
   */
  recent?: RecentThreadActions
  /** The avatar alone on the button, where there is no room for the name. */
  compact?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 gap-2 pl-1.5 font-semibold"
          aria-label={`${heading} ${value.name}. Change teammate`}
        >
          <TeammateAvatar teammate={value} className="size-5" />
          {!compact && <span className="max-w-40 truncate">{value.name}</span>}
          <ActivityDot activity={activity?.[value.id]} />
          <ChevronDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{heading}</DropdownMenuLabel>
        {teammates.map((t) => {
          const row = (
            <>
              <TeammateAvatar teammate={t} className="size-7" />
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-semibold">{t.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {teammateModelLabel(t)}
                </span>
              </span>
              <ActivityDot activity={activity?.[t.id]} />
              {t.id === value.id && <Check className="text-primary" aria-hidden />}
            </>
          )
          return recent ? (
            <DropdownMenuSub key={t.id}>
              <DropdownMenuSubTrigger className="gap-2.5">{row}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                <RecentThreads teammate={t} actions={recent} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem key={t.id} onSelect={() => onChange(t.id)} className="gap-2.5">
              {row}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const LAST_TEAMMATE = 'brigade.home.teammate'

/** The teammate new messages go to, remembered per browser. */
export function useLastTeammate() {
  const [id, setId] = useState<string>()
  useEffect(() => {
    try {
      setId(localStorage.getItem(LAST_TEAMMATE) ?? undefined)
    } catch {}
  }, [])
  return [
    id,
    (next: string) => {
      setId(next)
      try {
        localStorage.setItem(LAST_TEAMMATE, next)
      } catch {}
    },
  ] as const
}

const LAST_PROJECT = 'brigade.home.project'

/** The project new threads went in last ("none" for none), remembered per browser. */
function useLastProject() {
  const [id, setId] = useState<string>()
  useEffect(() => {
    try {
      setId(localStorage.getItem(LAST_PROJECT) ?? undefined)
    } catch {}
  }, [])
  return [
    id,
    (next: string) => {
      setId(next)
      try {
        localStorage.setItem(LAST_PROJECT, next)
      } catch {}
    },
  ] as const
}

/**
 * What a new thread is being written with: its message, files, computer and account.
 * Held by whoever owns it, so it outlives the box (the threads panel closing).
 */
export function useThreadDraft() {
  const [text, setText] = useState('')
  const [computerId, setComputerId] = useState<string>()
  const [accountId, setAccountId] = useState<string>()
  const files = useUploads()
  return { text, setText, computerId, setComputerId, accountId, setAccountId, files }
}

export type ThreadDraft = ReturnType<typeof useThreadDraft>

/**
 * The box a new thread starts from: a message, files, where it runs and on which account.
 * With `picker`, the member also chooses the teammate it goes to. With `draft`, what is
 * written is kept outside; with `onStarted`, the box stays put instead of opening the thread.
 */
export function NewThread({
  teammate,
  picker,
  placeholder,
  rows = 3,
  draft,
  onStarted,
  autoFocus,
  projectId: initialProject,
}: {
  /** The project the thread starts in unless changed, e.g. on a project page. */
  projectId?: string
  teammate: Teammate
  picker?: { teammates: Teammate[]; onChange: (id: string) => void }
  placeholder?: string
  rows?: number
  draft?: ThreadDraft
  onStarted?: (thread: { id: string }) => void
  /** Puts the cursor in the message as soon as the box appears. */
  autoFocus?: boolean
}) {
  const router = useRouter()
  const { projects } = useDashboard()
  const pickable = projects.filter((p) => !p.archivedAt)
  // A project page's own project first; else the one picked last, while it is still pickable.
  const [last, remember] = useLastProject()
  const [picked, setPicked] = useState<string>()
  useEffect(() => setPicked(undefined), [initialProject])
  const projectId =
    picked ?? initialProject ?? (last && pickable.some((p) => p.id === last) ? last : 'none')
  const chosenProject = pickable.find((p) => p.id === projectId)
  const setProjectId = (next: string) => {
    // Radix Select sometimes reports "" on its own; that is no choice.
    if (!next) return
    setPicked(next)
    remember(next)
  }
  const computers = useApi<ComputersResponse>('/computers')
  const accounts = useApi<Account[]>('/accounts')
  const own = useThreadDraft()
  const { text, setText, computerId, setComputerId, accountId, setAccountId, files } = draft ?? own
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const drop = useFileDrop(files.add)

  const online = usableComputers(computers.data)
  const computer = online.find((c) => c.id === computerId) ?? online[0]
  const usable = (accounts.data ?? []).filter(
    (a) =>
      a.computer.id === computer?.id &&
      a.provider === teammate.harness &&
      (a.status === 'ready' || a.status === 'unverified') &&
      !(a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()),
  )
  const account =
    usable.find((a) => a.id === accountId) ?? usable.find((a) => a.isDefault) ?? usable[0]

  const loaded = computers.data && accounts.data
  const ready =
    (text.trim() || files.ids.length > 0) && !files.busy && !files.failed && computer && account

  async function start(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(undefined)
    try {
      const thread = await api<{ id: string }>('/threads', {
        body: {
          teammateId: teammate.id,
          computerId: computer.id,
          accountId: account.id,
          text,
          attachmentIds: files.ids,
          ...(projectId !== 'none' && { projectId }),
        },
      })
      files.clear()
      if (onStarted) {
        setText('')
        setBusy(false)
        onStarted(thread)
      } else router.push(`/app/threads/${thread.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const link = 'font-medium text-primary hover:underline'
  let notice: React.ReactNode = null
  if (loaded && !computer)
    notice = (
      <>
        No computer is online.{' '}
        <Link href="/app/computers" className={link}>
          Link your machine
        </Link>{' '}
        to run threads on it.
      </>
    )
  else if (loaded && !account)
    notice = (
      <>
        No {harnessLabel(teammate.harness)} account on {computerName(computer!)}.{' '}
        <Link href="/app/accounts" className={link}>
          Add one
        </Link>
      </>
    )

  return (
    <form onSubmit={(e) => void start(e)} className="flex flex-col gap-2">
      <Card
        data-composer-frame
        className={cn(
          'relative gap-2 rounded-xl p-3 shadow-md focus-within:border-ring',
          drop.dragging && 'border-primary ring-[3px] ring-primary/30',
        )}
        {...drop.props}
      >
        <UploadList uploads={files.uploads} onRemove={files.remove} />
        <Composer
          bare
          rows={rows}
          value={text}
          onChange={setText}
          onSubmit={() => void start()}
          disabled={busy}
          autoFocus={autoFocus}
          placeholder={
            placeholder ??
            `What should ${teammate.name} do? @ to bring in a teammate, repository, connection or secret`
          }
        />
        <div className="flex flex-wrap items-center gap-1">
          {picker && (
            <TeammatePicker
              teammates={picker.teammates}
              value={teammate}
              onChange={picker.onChange}
            />
          )}
          <AttachButton onFiles={files.add} />
          {pickable.length > 0 && (
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger size="sm" aria-label="Project" className={cn(quietSelect, 'max-w-48')}>
                {/* Written out: SelectValue misses a value set once the projects have loaded. */}
                <SelectValue asChild>
                  <span className="flex min-w-0 items-center gap-2">
                    {chosenProject ? (
                      <ProjectIcon project={chosenProject} className="size-4 text-[0.625rem]" />
                    ) : (
                      <FolderKanban aria-hidden />
                    )}
                    <span className="truncate">{chosenProject?.name ?? 'No project'}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No project</SelectItem>
                <SelectSeparator />
                {pickable.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <ProjectIcon project={p} className="size-4 text-[0.625rem]" />
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {online.length > 1 && (
            <Select value={computer?.id} onValueChange={setComputerId}>
              <SelectTrigger size="sm" aria-label="Run on" className={quietSelect}>
                <Monitor aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {online.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {computerName(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {usable.length > 1 && (
            <Select key={computer?.id} value={account?.id} onValueChange={setAccountId}>
              <SelectTrigger size="sm" aria-label="Account" className={cn(quietSelect, 'max-w-60')}>
                <SelectValue />
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
          )}
          <Button size="sm" className="ml-auto" disabled={busy || !ready}>
            {busy ? 'Starting…' : 'Send'}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </Card>
      {(error || notice) && (
        <p
          className={cn('px-1 text-sm', error ? 'text-destructive-text' : 'text-muted-foreground')}
        >
          {error ?? notice}
        </p>
      )}
    </form>
  )
}
