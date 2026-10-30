'use client'
// A thread's menu: Pin, Do later, Rename, Archive and Delete, each with its letter, as in
// Claude: with the menu open, the letter does it. The same in its sidebar row and in its
// details panel, so a thread out of the sidebar (filtered, past "+N more", archived, put away
// for later) can be changed from inside.
import {
  Archive,
  ArchiveRestore,
  Clock,
  EllipsisVertical,
  Eye,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useDashboard, isAdmin } from '@/components/dashboard'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hint } from '@/components/ui/tooltip'
import { renamedHere } from '@/components/streamed-title'
import { useThreadPanel } from '@/components/thread-panel'
import { api, type Thread, type ThreadSummary } from '@/lib/api'

type Action = 'preview' | 'pin' | 'later' | 'rename' | 'archive' | 'delete'

export type MenuThread = Pick<
  ThreadSummary,
  'id' | 'title' | 'pinnedAt' | 'laterAt' | 'archivedAt' | 'othersMayPrompt' | 'previewRunning'
> & { startedBy: { id: string }; parent?: { id: string } | null }

/** What the menu shows for this member, and what each item does. */
export function useThreadMenu({
  thread,
  memberId,
  admin,
  onRename,
  onChanged,
  onDeleted,
}: {
  thread: MenuThread
  memberId: string | null
  admin: boolean
  /** Rename picked: where the title is edited is the caller's. */
  onRename: () => void
  onChanged: () => void
  onDeleted: (id: string) => void
}) {
  const title = thread.title || 'New thread'
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { openPreview } = useThreadPanel()

  const starter = thread.startedBy.id === memberId
  // As the API decides (routes/threads.ts): who may write in it renames and archives it,
  // its starter deletes it, and admins do all of them.
  const mayChange = starter || !!thread.othersMayPrompt || admin
  const mayDelete = starter || admin
  const pinned = !!thread.pinnedAt
  const archived = !!thread.archivedAt
  const later = !!thread.laterAt

  async function run(action: Action) {
    setOpen(false)
    if (action === 'preview') return openPreview(thread.id)
    if (action === 'rename') return onRename()
    if (action === 'delete' && !confirm(await deleteQuestion(thread.id, title))) return
    const path = `/threads/${thread.id}`
    setBusy(true)
    try {
      if (action === 'pin') await api(`${path}/pin`, { method: pinned ? 'DELETE' : 'POST' })
      else if (action === 'later') await api(`${path}/later`, { method: later ? 'DELETE' : 'POST' })
      else if (action === 'archive')
        await api(`${path}/archive`, { method: archived ? 'DELETE' : 'POST' })
      else {
        await api(path, { method: 'DELETE' })
        onDeleted(thread.id)
      }
      onChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const items: { action: Action; label: string; icon: ReactNode; key: string; show: boolean }[] = [
    {
      action: 'preview',
      label: 'Open preview',
      icon: <Eye />,
      key: 'O',
      show: !!thread.previewRunning,
    },
    {
      action: 'pin',
      label: pinned ? 'Unpin' : 'Pin',
      icon: pinned ? <PinOff /> : <Pin />,
      key: 'P',
      show: true,
    },
    // Each member's own, like a pin: out of their list and of what waits on them, until
    // something new happens in it. An archived thread is already put away.
    {
      action: 'later',
      label: later ? 'Move back' : 'Do later',
      icon: later ? <Undo2 /> : <Clock />,
      key: 'L',
      show: later || (!archived && !thread.parent),
    },
    { action: 'rename', label: 'Rename', icon: <Pencil />, key: 'R', show: mayChange },
    {
      action: 'archive',
      label: archived ? 'Unarchive' : 'Archive',
      icon: archived ? <ArchiveRestore /> : <Archive />,
      key: 'A',
      show: mayChange,
    },
    { action: 'delete', label: 'Delete', icon: <Trash2 />, key: 'D', show: mayDelete },
  ]
  const shown = items.filter((i) => i.show)

  function onMenuKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const item = shown.find((i) => i.key === e.key.toUpperCase())
    if (!item) return
    e.preventDefault()
    void run(item.action)
  }

  const content = shown.map((item) => (
    <Fragment key={item.action}>
      {item.action === 'delete' && <DropdownMenuSeparator />}
      <DropdownMenuItem
        variant={item.action === 'delete' ? 'destructive' : 'default'}
        onSelect={() => void run(item.action)}
      >
        {item.icon}
        {item.label}
        <DropdownMenuShortcut>{item.key}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </Fragment>
  ))

  return { title, open, setOpen, busy, onMenuKey, content, mayRename: mayChange }
}

/** A new title for it, from the sidebar row's field or the panel's prompt. */
export async function renameThread(id: string, current: string, next: string) {
  const value = next.trim()
  if (!value || value === current) return false
  try {
    renamedHere(id, value)
    await api(`/threads/${id}/title`, { method: 'PUT', body: { title: value } })
    return true
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
    return false
  }
}

/**
 * In the thread's details panel, beside its "Thread" heading, quiet as the sidebar row's ⋮:
 * that row's menu, for the thread open. Deleted, the thread is gone: back to Home.
 */
export function ThreadMenu({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const { me } = useDashboard()
  const { reloadThreads } = useThreadPanel()
  const router = useRouter()
  function changed() {
    onChanged()
    void reloadThreads()
  }
  const menu = useThreadMenu({
    thread,
    memberId: me.memberId,
    admin: isAdmin(me),
    onRename: () => {
      const next = prompt('Rename the thread', thread.title)
      if (next !== null)
        void renameThread(thread.id, thread.title, next).then((ok) => ok && changed())
    },
    onChanged: changed,
    onDeleted: () => router.push('/app'),
  })
  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      <Hint label="More">
        <DropdownMenuTrigger
          aria-label={`${menu.title}: more`}
          disabled={menu.busy}
          className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 data-[state=open]:bg-accent data-[state=open]:text-foreground [&>svg]:size-4"
        >
          <EllipsisVertical aria-hidden />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="min-w-44" onKeyDown={menu.onMenuKey}>
        {menu.content}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Delete's confirmation: the schedules reporting to the thread go with it, so it says so. */
async function deleteQuestion(id: string, title: string) {
  const schedules = await api<Thread>(`/threads/${id}`)
    .then((t) => t.reportingSchedules)
    .catch(() => [])
  const names = schedules.map((s) => `“${s.title}”`).join(', ')
  const also =
    schedules.length === 0
      ? ''
      : schedules.length === 1
        ? `\n\nThe schedule ${names} reports here: it will be deleted too, with its runs.`
        : `\n\nThe schedules ${names} report here: they will be deleted too, with their runs.`
  return `Delete “${title}” for good, with its files? This can't be undone.${also}`
}
