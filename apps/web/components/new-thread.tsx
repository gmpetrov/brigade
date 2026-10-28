'use client'
import { ArrowUp, Check, ChevronDown, FolderKanban, List, Monitor, Plus } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { defaultEffort, type Effort } from '@brigade/contracts'
import { ComposerMenu, UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { Composer } from '@/components/composer'
import { EffortButton, type EffortPick } from '@/components/effort'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { StatusDot } from '@/components/status-badge'
import { ProjectIcon } from '@/components/projects'
import { TeachTask } from '@/components/teach-task'
import { TeammateTitle } from '@/components/teammate-title'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
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
  preload,
  preloadSettled,
  teammateModelLabel,
  usableComputers,
  useApi,
  type Account,
  type ComputersResponse,
  type Teammate,
  type ThreadSummary,
} from '@/lib/api'
import { useIsMobile } from '@/hooks/use-mobile'
import { newThreadId, pendingThreads } from '@/lib/pending-threads'
import { preloadThreadEvents } from '@/lib/use-thread-events'
import { cn } from '@/lib/utils'

const quietSelect =
  'h-8 border-transparent bg-transparent shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent/50'

/** What a teammate is doing: working, or waiting on a person. */
export type TeammateActivity = 'busy' | 'waiting'

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

/**
 * Pick a teammate: who a new thread goes to (the lead; others join when the message
 * @mentions them), or whose threads the threads panel lists.
 */
export function TeammatePicker({
  teammates,
  value,
  onChange,
  heading = 'Send to',
  recent,
  compact = false,
  withTitle = false,
  numbered = false,
  onPicked,
}: {
  teammates: Teammate[]
  value: Teammate
  onChange: (id: string) => void
  /** Above the list, and what the button says it changes. */
  heading?: string
  /**
   * Each teammate opens its latest threads beside it, to go straight to one (or all of
   * them, or a new one) instead of only picking the teammate.
   */
  recent?: RecentThreadActions
  /** The avatar alone on the button, where there is no room for the name. */
  compact?: boolean
  /** The teammate's title as a badge beside its name. */
  withTitle?: boolean
  /** 1–9 pick the first nine while the menu is open, shown beside each. */
  numbered?: boolean
  /** Where focus goes once the menu closes, instead of back to its button. */
  onPicked?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
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
          {!compact && withTitle && <TeammateTitle title={value.title} />}
          <ChevronDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        onCloseAutoFocus={(e) => {
          if (!onPicked) return
          e.preventDefault()
          onPicked()
        }}
        onKeyDown={(e) => {
          if (!numbered || recent || e.metaKey || e.ctrlKey || e.altKey) return
          const picked = /^[1-9]$/.test(e.key) ? teammates[Number(e.key) - 1] : undefined
          if (!picked) return
          e.preventDefault()
          onChange(picked.id)
          setOpen(false)
        }}
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">{heading}</DropdownMenuLabel>
        {teammates.map((t, i) => {
          const row = (
            <>
              <TeammateAvatar teammate={t} className="size-7" />
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-semibold">{t.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {teammateModelLabel(t)}
                </span>
              </span>
              {t.id === value.id && <Check className="text-primary" aria-hidden />}
              {numbered && !recent && i < 9 && (
                <DropdownMenuShortcut className="ml-0 w-3 text-center">
                  {i + 1}
                </DropdownMenuShortcut>
              )}
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

/** The teammate `useLastTeammate` remembers, read at once. */
export function lastTeammate() {
  try {
    return localStorage.getItem(LAST_TEAMMATE) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The teammate new messages go to, remembered per browser. Read as it mounts: what asks is in
 * the dashboard, which shows only in the browser, once the member is in. A first render on
 * another teammate would load its threads for nothing.
 */
export function useLastTeammate() {
  const [id, setId] = useState(lastTeammate)
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
  // How hard its teammates think, from the + menu; null: the harness's default.
  const [effort, setEffort] = useState<Effort | null>(null)
  const files = useUploads()
  return {
    text,
    setText,
    computerId,
    setComputerId,
    accountId,
    setAccountId,
    effort,
    setEffort,
    files,
  }
}

export type ThreadDraft = ReturnType<typeof useThreadDraft>

/**
 * The box a new thread starts from: a message, files, where it runs and on which account.
 * With `picker`, the member also chooses the teammate it goes to. With `draft`, what is
 * written is kept outside; with `onStarted`, the box stays put instead of opening the thread.
 * With `onSending`, it does not wait for the thread either: the box empties at once and is
 * given back what was in it if the thread could not start. With neither, the thread opens at
 * once, before it exists (lib/pending-threads.ts), and the message comes back here if it could
 * not start.
 */
export function NewThread({
  teammate,
  picker,
  placeholder,
  rows = 3,
  draft,
  onStarted,
  onSending,
  autoFocus,
  typeToFocus,
  projectId: initialProject,
  layout = 'card',
  fill,
}: {
  /** The project the thread starts in unless changed, e.g. on a project page. */
  projectId?: string
  teammate: Teammate
  picker?: {
    teammates: Teammate[]
    onChange: (id: string) => void
    /** 1–9 pick a teammate while its menu is open. */
    numbered?: boolean
  }
  placeholder?: string
  rows?: number
  draft?: ThreadDraft
  onStarted?: (thread: { id: string }) => void
  /** Sent, the thread still starting: it settles with the thread, or the reason it did not. */
  onSending?: (thread: Promise<{ id: string }>) => void
  /** Puts the cursor in the message as soon as the box appears. */
  autoFocus?: boolean
  /** The page's main message box: typing with nothing focused lands in it (Composer). */
  typeToFocus?: boolean
  /** In a card (a page, the threads panel), or the whole of a dialog. */
  layout?: 'card' | 'dialog'
  /**
   * The dialog is a whole window with no title bar (Brigade.app's capture): the message grows
   * to fill it, and its first row makes room for the window buttons and drags the window.
   */
  fill?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { me, projects } = useDashboard()
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
  const {
    text,
    setText,
    computerId,
    setComputerId,
    accountId,
    setAccountId,
    effort: effortValue,
    setEffort: setEffortValue,
    files,
  } = draft ?? own
  const effort: EffortPick = {
    value: effortValue,
    fallback: defaultEffort(teammate.harness, teammate.model),
    onPick: setEffortValue,
  }
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // A message whose thread did not start, back from it (lib/pending-threads.ts).
  useEffect(() => {
    const back = pendingThreads.takeReturned(pathname)
    if (!back) return
    setText((now) => (now.trim() ? now : back.text))
    files.put(back.uploads)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const drop = useFileDrop(files.add)
  // Teach a task: recorded on the cloud computer, and the thread starts once it is sent.
  const [teaching, setTeaching] = useState(false)
  const phone = useIsMobile()

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

  const create = (message: string, attachmentIds: string[], id?: string) =>
    api<{ id: string }>('/threads', {
      body: {
        ...(id && { id }),
        teammateId: teammate.id,
        computerId: computer!.id,
        accountId: account!.id,
        text: message,
        attachmentIds,
        ...(projectId !== 'none' && { projectId }),
        ...(effortValue && { effort: effortValue }),
      },
    })

  async function start(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !ready) return
    if (onSending) {
      const sending = create(text, files.ids)
      const effortWas = effortValue
      const taken = files.take()
      setText('')
      setEffortValue(null)
      onSending(
        sending.then(
          (thread) => {
            taken.done()
            return thread
          },
          (error: unknown) => {
            // Back in the box, unless something new was written there meanwhile.
            setText((now) => (now.trim() ? now : text))
            setEffortValue((now) => now ?? effortWas)
            taken.restore()
            throw error
          },
        ),
      )
      return
    }
    if (!onStarted) {
      // Opened at once: it shows this message until it has started, then its conversation.
      const id = newThreadId()
      const sending = create(text, files.ids, id)
      const taken = files.take()
      pendingThreads.add(
        id,
        { teammate, text, files: taken.uploads.map((u) => u.name), from: pathname },
        taken.uploads,
      )
      setText('')
      setEffortValue(null)
      router.push(`/app/threads/${id}`)
      sending.then(
        async () => {
          // Its conversation takes over once what it opens on is in: no blank in between.
          preload(`/threads/${id}`)
          preloadThreadEvents(id)
          await Promise.all([
            preloadSettled(`/threads/${id}`),
            preloadSettled(`/threads/${id}/events`),
          ])
          pendingThreads.started(id)
          taken.done()
        },
        (error: unknown) => pendingThreads.failed(id, (error as Error).message),
      )
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const thread = await create(text, files.ids)
      files.clear()
      // The effort went with that thread; the next one starts on Default, even from a
      // draft that outlives the box (the threads panel).
      setEffortValue(null)
      setText('')
      setBusy(false)
      onStarted(thread)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  // The recording is the new thread's first message; what is written here stays for later.
  async function sendRecording(message: string, attachmentIds: string[]) {
    const thread = await create(message, attachmentIds)
    if (onStarted) onStarted(thread)
    else router.push(`/app/threads/${thread.id}`)
  }
  const teach = !computer
    ? 'No computer is online'
    : computer.kind !== 'cloud'
      ? 'Not yet on threads that run on a member’s machine'
      : !account
        ? `No ${harnessLabel(teammate.harness)} account on the cloud computer`
        : () => setTeaching(true)

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

  // In a dialog, picking who or where puts the cursor back in the message.
  const form = useRef<HTMLFormElement>(null)
  const focusMessage = () =>
    form.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
  const uploads = <UploadList uploads={files.uploads} onRemove={files.remove} />
  const composer = (
    <Composer
      bare
      fill={fill}
      rows={rows}
      value={text}
      onChange={setText}
      onSubmit={() => void start()}
      disabled={busy}
      autoFocus={autoFocus}
      typeToFocus={typeToFocus}
      placeholder={placeholder ?? `Chat with ${teammate.name}`}
    />
  )
  const teammatePicker = picker && (
    <TeammatePicker
      teammates={picker.teammates}
      value={teammate}
      onChange={picker.onChange}
      numbered={picker.numbered}
      onPicked={layout === 'dialog' ? focusMessage : undefined}
    />
  )
  const chosenLabel = (
    <span className="flex min-w-0 items-center gap-2">
      {chosenProject ? (
        <ProjectIcon project={chosenProject} className="size-4 text-[0.625rem]" />
      ) : (
        <FolderKanban aria-hidden />
      )}
      <span className="truncate">{chosenProject?.name ?? 'No project'}</span>
    </span>
  )
  const projectPicker = pickable.length > 0 && (
    <Select value={projectId} onValueChange={setProjectId}>
      <SelectTrigger size="sm" aria-label="Project" className={cn(quietSelect, 'max-w-48')}>
        {/* Written out: SelectValue misses a value set once the projects have loaded. The same as
            its placeholder, which Radix shows while it takes the value for empty (not asChild:
            it would hand its props to the placeholder's Fragment). */}
        <SelectValue placeholder={chosenLabel}>{chosenLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent
        onCloseAutoFocus={(e) => {
          if (layout !== 'dialog') return
          e.preventDefault()
          focusMessage()
        }}
      >
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
  )
  const where = (
    <>
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
    </>
  )
  // The +, as in a thread, phones included, where there is no teaching. The quick dialog
  // has no teaching either: its modal would keep the recording's computer from use.
  const add = (
    <ComposerMenu
      onFiles={files.add}
      effort={effort}
      {...(phone || layout === 'dialog' ? {} : { teach })}
    />
  )
  const recorder = teaching && (
    <TeachTask
      teammate={teammate}
      memberId={me.memberId ?? ''}
      onSend={sendRecording}
      onClose={() => setTeaching(false)}
    />
  )
  // As in a thread, the send button shows once there is something to send.
  const send = (text.trim() || files.uploads.length > 0) && (
    <Button
      size="icon-sm"
      className="ml-auto rounded-full [&_svg:not([class*='size-'])]:size-5"
      disabled={busy || !ready}
      aria-label={busy ? 'Starting…' : 'Send'}
      title={busy ? 'Starting…' : 'Send (↵)'}
    >
      <ArrowUp aria-hidden />
    </Button>
  )
  const message = (error || notice) && (
    <p className={cn('px-1 text-sm', error ? 'text-destructive-text' : 'text-muted-foreground')}>
      {error ?? notice}
    </p>
  )

  // The dialog is the box: who and where read as a sentence above the message, the
  // rest below it, with no card of its own inside the dialog's.
  if (layout === 'dialog')
    return (
      <form
        ref={form}
        onSubmit={(e) => void start(e)}
        // The mention menu docks to the whole box, above or below it.
        data-composer-frame
        className={cn(
          'relative flex flex-col rounded-[inherit]',
          fill && 'min-h-0 flex-1',
          drop.dragging && 'ring-[3px] ring-primary/30 ring-inset',
        )}
        {...drop.props}
      >
        <div
          // A whole window has no title bar: its macOS buttons sit at the start of this row
          // (capture.rs), and the row drags the window, its pickers aside.
          data-tauri-drag-region={fill ? 'deep' : undefined}
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-1 px-3 py-2 text-sm text-muted-foreground',
            fill && 'min-h-[52px] pl-[78px] select-none',
          )}
        >
          <span className="pl-1">New thread for</span>
          {teammatePicker ?? <span className="font-semibold text-foreground">{teammate.name}</span>}
          {projectPicker && (
            <>
              <span>in</span>
              {projectPicker}
            </>
          )}
        </div>
        <div className={cn('flex flex-col gap-2 border-t px-4 py-3', fill && 'min-h-0 flex-1')}>
          {uploads}
          {composer}
        </div>
        {message && <div className="px-3 pb-2">{message}</div>}
        <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2">
          {add}
          {where}
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              esc to close · ↵ to send
            </span>
            <div className="flex items-center gap-1">
              <EffortButton effort={effort} />
              {send}
            </div>
          </div>
        </div>
      </form>
    )

  // The recording outside the form: its events would reach the form through the portal.
  return (
    <>
      <form onSubmit={(e) => void start(e)} className="flex flex-col gap-2">
        <Card
          data-composer-frame
          className={cn(
            'relative gap-2 rounded-xl p-3 shadow-md focus-within:border-ring',
            drop.dragging && 'border-primary ring-[3px] ring-primary/30',
          )}
          {...drop.props}
        >
          {uploads}
          {composer}
          <div className="flex flex-wrap items-center gap-1">
            {add}
            {teammatePicker}
            {projectPicker}
            {where}
            <div className="ml-auto flex items-center gap-1">
              <EffortButton effort={effort} />
              {send}
            </div>
          </div>
        </Card>
        {message}
      </form>
      {recorder}
    </>
  )
}
