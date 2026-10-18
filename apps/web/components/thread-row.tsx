'use client'
// A thread in the sidebar, with its menu: ⋮ on hover in place of the time, or a right-click
// on the row. Pin, Rename, Archive and Delete, each with its letter, as in Claude: with the
// menu open, the letter does it. Rename edits the title in the row itself.
import {
  Archive,
  ArchiveRestore,
  EllipsisVertical,
  Laptop,
  MonitorPlay,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { renamedHere, StreamedTitle } from '@/components/streamed-title'
import { api, type ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

type Action = 'pin' | 'rename' | 'archive' | 'delete'

export function ThreadRow({
  thread,
  href,
  active,
  icon,
  trailing,
  memberId,
  admin,
  onChanged,
  onDeleted,
}: {
  thread: ThreadSummary
  href: string
  active: boolean
  icon: ReactNode
  /** At the row's end: its time or what it asks. Hidden while the menu is in reach. */
  trailing: ReactNode
  memberId: string | null
  admin: boolean
  onChanged: () => void
  onDeleted: (id: string) => void
}) {
  const title = thread.title || 'New thread'
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)

  const starter = thread.startedBy.id === memberId
  // As the API decides (routes/threads.ts): who may write in it renames and archives it,
  // its starter deletes it, and admins do all of them.
  const mayChange = starter || !!thread.othersMayPrompt || admin
  const mayDelete = starter || admin
  const pinned = !!thread.pinnedAt
  const archived = !!thread.archivedAt

  async function run(action: Action) {
    setOpen(false)
    if (action === 'rename') return setRenaming(true)
    if (
      action === 'delete' &&
      !confirm(`Delete “${title}” for good, with its files? This can't be undone.`)
    )
      return
    const path = `/threads/${thread.id}`
    setBusy(true)
    try {
      if (action === 'pin') await api(`${path}/pin`, { method: pinned ? 'DELETE' : 'POST' })
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

  async function rename(next: string) {
    setRenaming(false)
    const value = next.trim()
    if (!value || value === thread.title) return
    try {
      renamedHere(thread.id, value)
      await api(`/threads/${thread.id}/title`, { method: 'PUT', body: { title: value } })
      onChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const items: { action: Action; label: string; icon: ReactNode; key: string; show: boolean }[] = [
    {
      action: 'pin',
      label: pinned ? 'Unpin' : 'Pin',
      icon: pinned ? <PinOff /> : <Pin />,
      key: 'P',
      show: true,
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

  if (renaming)
    return (
      <SidebarMenuItem>
        <div className="flex h-8 items-center gap-2 rounded-md px-2 ring-1 ring-sidebar-ring">
          {icon}
          <input
            autoFocus
            defaultValue={thread.title}
            aria-label="Thread title"
            maxLength={200}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => void rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(false)
              }
            }}
          />
        </div>
      </SidebarMenuItem>
    )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} className={cn(busy && 'opacity-60')}>
        <Link
          href={href}
          title={title}
          onContextMenu={(e) => {
            e.preventDefault()
            setOpen(true)
          }}
        >
          {icon}
          <span className="flex-1 truncate">
            <StreamedTitle threadId={thread.id} text={title} />
          </span>
          <span
            className={cn(
              'ml-auto flex shrink-0 items-center gap-1.5 text-xs',
              // On a phone ⋮ is always there: the time goes beside it.
              'max-md:mr-5 md:group-hover/menu-item:opacity-0',
              open && 'opacity-0',
            )}
          >
            {/* Its preview is up: people can try what it builds. */}
            {thread.previewRunning && (
              <span title="Preview running" className="flex">
                <MonitorPlay aria-hidden className="size-3 opacity-50" />
                <span className="sr-only">Preview running</span>
              </span>
            )}
            {/* On a member's own machine; no laptop means the workspace computer. */}
            {thread.computer.kind === 'member_machine' && (
              <span title={`Runs on ${thread.computer.name}`} className="flex">
                <Laptop aria-hidden className="size-3 opacity-50" />
                <span className="sr-only">Runs on {thread.computer.name}</span>
              </span>
            )}
            {trailing}
          </span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        {/* Only on the hovered row, or while its menu is open: not left behind on a row that
            keeps the focus after a click or a shortcut. Always there on a phone. */}
        <SidebarMenuAction asChild>
          <DropdownMenuTrigger
            aria-label={`${title}: more`}
            title="More"
            className="data-[state=open]:bg-sidebar-accent group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0"
          >
            <EllipsisVertical />
          </DropdownMenuTrigger>
        </SidebarMenuAction>
        <DropdownMenuContent
          align="start"
          side="right"
          className="min-w-44"
          onKeyDown={onMenuKey}
          // Not back to ⋮: focused, it would stay shown once the pointer has left the row.
          // Rename puts the focus in its field instead.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {shown.map((item) => (
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
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
