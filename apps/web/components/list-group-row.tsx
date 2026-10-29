'use client'
// A list in the sidebar (docs/lists.md): the threads working on its items fold under it, as a
// thread's child threads do. Its title opens the list; the caret after it folds its threads;
// its dot is its threads' most pressing state (lib/list-groups.ts).
import { ListChecks, Play } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { FadeText } from '@/components/fade-text'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

export function ListGroupRow({
  title,
  href,
  active,
  dot,
  working = false,
  hint,
  caret,
}: {
  title: string
  href: string
  active: boolean
  dot?: ReactNode
  working?: boolean
  hint?: string
  caret: { open: boolean; count: number; onToggle: () => void }
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link href={href} title={hint ? `${title} · ${hint}` : title}>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <ListChecks aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <FadeText textClassName={cn(working && 'text-shimmer-dim')}>{title}</FadeText>
            {/* Folds its threads under it, without opening the list. From the keyboard, a
                button below it does the same (SubThreads). */}
            <span
              aria-hidden
              // Folds in place: on a phone, the sidebar stays open (ui/sidebar.tsx).
              data-keeps-sidebar
              title={
                caret.open
                  ? 'Hide its threads'
                  : `Show its ${caret.count} thread${caret.count === 1 ? '' : 's'}`
              }
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
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs">
            {/* Kept empty when there is no dot, so every row's end lines up. */}
            {dot ?? <span aria-hidden className="size-4" />}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
