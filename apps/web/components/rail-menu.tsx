'use client'
// The folded sidebar's way to a list (threads, projects, teammates): its icon, and beside it
// a menu of the list. Hovering the icon opens it, without taking the focus from what the
// member is typing, and it closes once the pointer leaves the icon and the menu. A click or
// the keyboard opens it as before, and it then stays open until dismissed.
import { Plus, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
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
/** Long enough to cross from the icon to the menu. */
const CLOSE_DELAY = 200

/** The menu open by hover, so that hovering another icon closes it at once. */
let hovered: (() => void) | null = null

export type RailMenuItem = {
  /** When two go to the same address. */
  id?: string
  href: string
  label: string
  icon: ReactNode
  /** At the row's end: what a thread asks, or how old it is. */
  trailing?: ReactNode
  onSelect?: () => void
}

/**
 * Between the items: a heading ("Pinned"), a line, or a control such as "+N more" with no
 * icon, its text lined up with theirs. A control keeps the menu open, so the list grows in it.
 */
export type RailMenuControl =
  | { kind: 'label'; key: string; label: string }
  | { kind: 'separator'; key: string }
  | { kind: 'more'; key: string; label: string; disabled?: boolean; onSelect: () => void }

export function RailMenu({
  icon: Icon,
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
  items: (RailMenuItem | RailMenuControl)[]
  action?: { label: string; onSelect: () => void }
}) {
  const [open, setOpen] = useState(false)
  const triggerId = useId()
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
    if (open && byHover.current) timer.current = window.setTimeout(close, CLOSE_DELAY)
  }

  return (
    <SidebarMenuItem>
      <DropdownMenu
        modal={false}
        open={open}
        onOpenChange={(next) => {
          clear()
          byHover.current = false
          if (next) focusBack.current = true
          setOpen(next)
        }}
      >
        <DropdownMenuTrigger
          asChild
          onPointerEnter={enter}
          onPointerLeave={leave}
          // A click on a menu hovered open keeps it open, now until dismissed.
          onPointerDown={(e) => {
            if (open && byHover.current) {
              e.preventDefault()
              clear()
              byHover.current = false
            }
          }}
        >
          <SidebarMenuButton isActive={active} aria-label={label} data-rail-menu={triggerId}>
            <Icon />
            <span>{label}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] max-w-80 min-w-52"
          onPointerEnter={enter}
          onPointerLeave={leave}
          // Its icon is outside the menu: a click on it is the icon's to handle, above.
          onPointerDownOutside={(e) => {
            const target = e.target as Element | null
            if (target?.closest(`[data-rail-menu="${triggerId}"]`)) e.preventDefault()
          }}
          {...{
            // Radix passes it on to the menu's focus scope, though its types leave it out.
            onOpenAutoFocus: (e: Event) => {
              if (byHover.current) e.preventDefault()
            },
          }}
          onCloseAutoFocus={(e) => {
            if (!focusBack.current) e.preventDefault()
          }}
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
          {items.map((item) =>
            'kind' in item ? (
              item.kind === 'label' ? (
                <DropdownMenuLabel key={item.key} className="text-muted-foreground text-xs">
                  {item.label}
                </DropdownMenuLabel>
              ) : item.kind === 'separator' ? (
                <DropdownMenuSeparator key={item.key} />
              ) : (
                <DropdownMenuItem
                  key={item.key}
                  className="text-muted-foreground pl-8"
                  disabled={item.disabled}
                  onSelect={(e) => {
                    e.preventDefault()
                    item.onSelect()
                  }}
                >
                  {item.label}
                </DropdownMenuItem>
              )
            ) : (
              <DropdownMenuItem key={item.id ?? item.href} asChild onSelect={item.onSelect}>
                <Link href={item.href} title={item.label}>
                  {item.icon}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.trailing}
                </Link>
              </DropdownMenuItem>
            ),
          )}
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
