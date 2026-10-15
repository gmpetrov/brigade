'use client'
// The folded sidebar's way to a list (threads, projects, teammates): its icon, and beside it
// the list. Hovering the icon opens it, without taking the focus from what the member is
// typing, and it closes once the pointer leaves the icon and the list. A click or the
// keyboard opens it as before, and it then stays open until dismissed. Projects and
// teammates are a menu; threads are a panel of the sidebar's own rows, with their ⋮.
import { Plus, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'

const OPEN_DELAY = 80
/** Long enough to cross from the icon to the list. */
const CLOSE_DELAY = 200

/** The list open by hover, so that hovering another icon closes it at once. */
let hovered: (() => void) | null = null

/** Whether the pointer is in a menu opened from the list (a thread's ⋮): it is still in it. */
const inNestedMenu = (panel: string) =>
  !!document.querySelector(`[data-rail-panel="${panel}"] [aria-haspopup="menu"][data-state="open"]`)

/**
 * Open on hover, on a click or by the keyboard. `trigger` and `content` go on the icon and
 * the list.
 */
function useRailOpen() {
  const [open, setOpen] = useState(false)
  const id = useId()
  // Opened by hovering: leaving closes it, and the focus stays where it was.
  const byHover = useRef(false)
  // Opened by a click or the keyboard: closing gives the focus back to the icon.
  const focusBack = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const clear = () => window.clearTimeout(timer.current)
  useEffect(() => clear, [])

  function close() {
    clear()
    byHover.current = false
    setOpen(false)
    if (hovered === close) hovered = null
  }
  function enter(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    clear()
    if (open) return
    timer.current = window.setTimeout(() => {
      if (hovered !== close) hovered?.()
      hovered = close
      byHover.current = true
      focusBack.current = false
      setOpen(true)
    }, OPEN_DELAY)
  }
  function leave(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    clear()
    if (open && byHover.current)
      timer.current = window.setTimeout(() => {
        if (!inNestedMenu(id)) close()
      }, CLOSE_DELAY)
  }

  return {
    open,
    onOpenChange(next: boolean) {
      clear()
      byHover.current = false
      if (next) focusBack.current = true
      setOpen(next)
    },
    trigger: {
      onPointerEnter: enter,
      onPointerLeave: leave,
      // A click on a list hovered open keeps it open, now until dismissed.
      onPointerDown(e: PointerEvent) {
        if (open && byHover.current) {
          e.preventDefault()
          clear()
          byHover.current = false
        }
      },
    },
    icon: { 'data-rail-menu': id },
    content: {
      'data-rail-panel': id,
      onPointerEnter: enter,
      onPointerLeave: leave,
      // Its icon is outside the list: a click on it is the icon's to handle, above. And a
      // menu opened from the list (a thread's ⋮) is in it.
      onPointerDownOutside(e: Event) {
        const target = e.target as Element | null
        if (
          target?.closest(`[data-rail-menu="${id}"]`) ||
          target?.closest('[data-slot="dropdown-menu-content"]')
        )
          e.preventDefault()
      },
      onOpenAutoFocus(e: Event) {
        if (byHover.current) e.preventDefault()
      },
      onCloseAutoFocus(e: Event) {
        if (!focusBack.current) e.preventDefault()
      },
    },
  }
}

function RailIcon({
  icon: Icon,
  label,
  active,
  ...props
}: {
  icon: LucideIcon
  label: string
  active: boolean
}) {
  return (
    <SidebarMenuButton isActive={active} aria-label={label} {...props}>
      <Icon />
      <span>{label}</span>
    </SidebarMenuButton>
  )
}

export type RailMenuItem = {
  /** When two go to the same address. */
  id?: string
  href: string
  label: string
  icon: ReactNode
  onSelect?: () => void
}

/** A list as a menu: its page first, then its items, and an action ("New project") last. */
export function RailMenu({
  icon,
  label,
  href,
  active,
  items,
  action,
}: {
  icon: LucideIcon
  label: string
  /** The list's own page, first in the menu. */
  href?: string
  active: boolean
  items: RailMenuItem[]
  action?: { label: string; onSelect: () => void }
}) {
  const rail = useRailOpen()
  return (
    <SidebarMenuItem>
      <DropdownMenu modal={false} open={rail.open} onOpenChange={rail.onOpenChange}>
        <DropdownMenuTrigger asChild {...rail.trigger}>
          <RailIcon icon={icon} label={label} active={active} {...rail.icon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] max-w-80 min-w-52"
          {...rail.content}
        >
          {href ? (
            <DropdownMenuItem asChild>
              <Link href={href} className="text-muted-foreground text-xs font-medium">
                {label}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuLabel className="text-muted-foreground text-xs">{label}</DropdownMenuLabel>
          )}
          {items.map((item) => (
            <DropdownMenuItem key={item.id ?? item.href} asChild onSelect={item.onSelect}>
              <Link href={item.href} title={item.label}>
                {item.icon}
                <span className="truncate">{item.label}</span>
              </Link>
            </DropdownMenuItem>
          ))}
          {action && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={action.onSelect}>
                <Plus /> {action.label}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

/**
 * A list as a panel of the sidebar's own rows (`children`), with what they do there: the
 * threads, each with its ⋮. Its heading links to the list's page.
 */
export function RailPanel({
  icon,
  label,
  href,
  active,
  children,
}: {
  icon: LucideIcon
  label: string
  href: string
  active: boolean
  children: ReactNode
}) {
  const rail = useRailOpen()
  return (
    <SidebarMenuItem>
      <Popover.Root open={rail.open} onOpenChange={rail.onOpenChange}>
        <Popover.Trigger asChild {...rail.trigger}>
          <RailIcon icon={icon} label={label} active={active} {...rail.icon} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="right"
            align="start"
            sideOffset={4}
            className="bg-sidebar text-sidebar-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-50 flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-72 flex-col gap-1 overflow-y-auto rounded-md border p-1 shadow-md"
            {...rail.content}
            // Esc in a field (a thread's title, renamed) is the field's: it stops editing.
            onEscapeKeyDown={(e) => {
              if ((e.target as Element | null)?.closest?.('input')) e.preventDefault()
            }}
            // Going to a thread (or the list's page) is done with it, as with a menu item.
            onClick={(e) => {
              if ((e.target as Element).closest('a[href]')) rail.onOpenChange(false)
            }}
          >
            <Link
              href={href}
              className="text-muted-foreground hover:text-sidebar-foreground px-2 py-1.5 text-xs font-medium"
            >
              {label}
            </Link>
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </SidebarMenuItem>
  )
}
