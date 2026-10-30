'use client'
// A list in the sidebar (docs/lists.md): the threads working on its items fold under it, as a
// thread's child threads do. Its title opens the list; the caret after it folds its threads;
// its dot is its threads' most pressing state (lib/list-groups.ts). Its menu (⋮ on hover in
// place of the dot, or a right-click on the row) pins it under Pinned, each member's own; there
// it can be dragged to another place (`drag`), and it stays even with no thread on it.
import { EllipsisVertical, ListChecks, Pin, PinOff, Play } from 'lucide-react'
import Link from 'next/link'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { FadeText } from '@/components/fade-text'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { Hint, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function ListGroupRow({
  title,
  href,
  active,
  dot,
  working = false,
  hint,
  caret,
  pinned,
  onPin,
  drag,
}: {
  title: string
  href: string
  active: boolean
  dot?: ReactNode
  working?: boolean
  hint?: string
  /** It has threads: a caret after its title folds them under it. */
  caret?: { open: boolean; count: number; onToggle: () => void }
  pinned: boolean
  /** Pin picked: pins it, or unpins it when pinned. */
  onPin: () => Promise<void>
  /** Under Pinned: the row's drag handlers and the drop line's class. */
  drag?: ComponentProps<'li'>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  async function pin() {
    setOpen(false)
    setBusy(true)
    try {
      await onPin()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SidebarMenuItem {...drag}>
      <SidebarMenuButton
        asChild
        isActive={active}
        className={cn(
          busy && 'opacity-60',
          // The dot takes ⋮'s place: no room kept for ⋮ beside it.
          'group-has-data-[sidebar=menu-action]/menu-item:pr-2',
        )}
      >
        <Link
          href={href}
          title={hint ? `${title} · ${hint}` : title}
          onContextMenu={(e) => {
            e.preventDefault()
            setOpen(true)
          }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <ListChecks aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <FadeText textClassName={cn(working && 'text-shimmer-dim')}>{title}</FadeText>
            {/* Folds its threads under it, without opening the list. From the keyboard, a
                button below it does the same (SubThreads). */}
            {caret && (
              <Hint
                label={
                  caret.open
                    ? 'Hide its threads'
                    : `Show its ${caret.count} thread${caret.count === 1 ? '' : 's'}`
                }
              >
                <span
                  aria-hidden
                  // Folds in place: on a phone, the sidebar stays open (ui/sidebar.tsx).
                  data-keeps-sidebar
                  className="text-muted-foreground hover:text-sidebar-foreground -m-1 flex shrink-0 p-1"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    caret.onToggle()
                  }}
                >
                  <Play
                    className={cn(
                      'size-2 fill-current transition-transform',
                      caret.open && 'rotate-90',
                    )}
                  />
                </span>
              </Hint>
            )}
          </span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-xs',
              // On a phone ⋮ is always there: the dot goes beside it.
              'max-md:mr-5 md:group-hover/menu-item:opacity-0',
              open && 'opacity-0',
            )}
          >
            {/* Kept empty when there is no dot, so every row's end lines up under ⋮. */}
            {dot ?? <span aria-hidden className="size-4" />}
          </span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        {/* Only on the hovered row, or while its menu is open, as on a thread's row. */}
        {/* The menu's trigger is the tooltip's, not wrapped in it: it keeps its own data-state. */}
        <Tooltip>
          <SidebarMenuAction asChild>
            <DropdownMenuTrigger
              asChild
              aria-label={`${title}: more`}
              className="data-[state=open]:bg-sidebar-accent group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0"
            >
              <TooltipTrigger>
                <EllipsisVertical />
              </TooltipTrigger>
            </DropdownMenuTrigger>
          </SidebarMenuAction>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          side="right"
          className="min-w-44"
          // With the menu open, its letter does it, as in a thread's menu.
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.key.toUpperCase() !== 'P') return
            e.preventDefault()
            void pin()
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenuItem onSelect={() => void pin()}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? 'Unpin' : 'Pin'}
            <DropdownMenuShortcut>P</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
