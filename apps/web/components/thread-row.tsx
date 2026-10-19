'use client'
// A thread in the sidebar, with its menu (thread-menu.tsx): ⋮ on hover in place of the time,
// or a right-click on the row. Rename edits the title in the row itself. A thread whose
// preview is up shows its icon, which opens the preview on hover (and in the menu on phones).
import { EllipsisVertical, Laptop, MonitorPlay } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { StreamedTitle } from '@/components/streamed-title'
import { renameThread, useThreadMenu } from '@/components/thread-menu'
import { useThreadPanel } from '@/components/thread-panel'
import { type ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

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
  const [renaming, setRenaming] = useState(false)
  const { openPreview } = useThreadPanel()
  const { title, open, setOpen, busy, onMenuKey, content } = useThreadMenu({
    thread,
    memberId,
    admin,
    onRename: () => setRenaming(true),
    onChanged,
    onDeleted,
  })

  async function rename(next: string) {
    setRenaming(false)
    if (await renameThread(thread.id, thread.title, next)) onChanged()
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
      <SidebarMenuButton
        asChild
        isActive={active}
        className={cn(
          busy && 'opacity-60',
          // On hover the title makes room for the preview's button beside ⋮.
          thread.previewRunning && 'md:group-hover/menu-item:pr-14!',
        )}
      >
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
      {/* Its preview, in reach on hover beside ⋮ where the icon was; on a phone, in ⋮. */}
      {thread.previewRunning && (
        <SidebarMenuAction
          aria-label={`${title}: open preview`}
          title="Open preview"
          onClick={() => openPreview(thread.id)}
          className="right-7 group-hover/menu-item:opacity-100 focus-visible:opacity-100 max-md:hidden md:opacity-0"
        >
          <MonitorPlay />
        </SidebarMenuAction>
      )}
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
          {content}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
