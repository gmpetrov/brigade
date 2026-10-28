'use client'
// A thread in the sidebar, with its menu (thread-menu.tsx): ⋮ on hover in place of its status
// dot, or a right-click on the row. The dot shows only while the thread has a state; how old it
// is and what the dot means show on hover, in the row's tooltip. Rename, or a double-click on the title, edits the title in the
// row itself. Under Pinned, a row can be dragged to another place (`drag`). A thread whose
// preview is up shows its icon, which opens the preview on hover (and in the menu on phones).
import { EllipsisVertical, Laptop, Eye } from 'lucide-react'
import Link from 'next/link'
import { useState, type ComponentProps, type ReactNode } from 'react'
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
  dot,
  working = false,
  hint,
  trailing,
  memberId,
  admin,
  onChanged,
  onDeleted,
  drag,
}: {
  thread: ThreadSummary
  href: string
  active: boolean
  /** Before the time, only while the thread has something to say: none when it is idle and read. */
  dot?: ReactNode
  /** A teammate works in it: a band passes over its title, beside its dot. */
  working?: boolean
  /** After the title in its tooltip: what the dot means, and how old the thread is. */
  hint?: string
  /** Before the dot, when a row needs more than its title (its date). Hidden with the dot. */
  trailing?: ReactNode
  memberId: string | null
  admin: boolean
  onChanged: () => void
  onDeleted: (id: string) => void
  /** Under Pinned: the row's drag handlers and the drop line's class. */
  drag?: ComponentProps<'li'>
}) {
  const [renaming, setRenaming] = useState(false)
  const { openPreview } = useThreadPanel()
  const { title, open, setOpen, busy, onMenuKey, content, mayRename } = useThreadMenu({
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
    <SidebarMenuItem {...drag}>
      <SidebarMenuButton
        asChild
        isActive={active}
        className={cn(
          busy && 'opacity-60',
          // The dot takes ⋮'s place: no room kept for ⋮ beside it.
          'group-has-data-[sidebar=menu-action]/menu-item:pr-2',
          // On hover the title makes room for the preview's button beside ⋮.
          thread.previewRunning && 'md:group-hover/menu-item:pr-14!',
        )}
      >
        <Link
          href={href}
          title={hint ? `${title} · ${hint}` : title}
          onContextMenu={(e) => {
            e.preventDefault()
            setOpen(true)
          }}
          // The first click opened the thread; the second edits its title, as Rename does.
          onDoubleClick={(e) => {
            if (!mayRename) return
            e.preventDefault()
            setRenaming(true)
          }}
        >
          <span className={cn('flex-1 truncate', working && 'text-shimmer-dim')}>
            <StreamedTitle threadId={thread.id} text={title} />
          </span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-xs',
              // On a phone ⋮ is always there: the dot goes beside it.
              'max-md:mr-5 md:group-hover/menu-item:opacity-0',
              open && 'opacity-0',
            )}
          >
            {trailing}
            {/* Its preview is up: people can try what it builds. */}
            {thread.previewRunning && (
              <span title="Preview running" className="flex">
                <Eye aria-hidden className="size-3 opacity-50" />
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
            {/* Kept empty when there is no dot, so every row's end lines up under ⋮. */}
            {dot ?? <span aria-hidden className="size-4" />}
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
          <Eye />
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
