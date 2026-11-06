'use client'
import { ChevronDown, Gauge } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { machineName, resetLabel, UsageMeters } from '@/components/account-card'
import { HarnessLogo } from '@/components/harness-logo'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'
import { harnessLabel, type Account } from '@/lib/api'
import { cn } from '@/lib/utils'

const PROVIDERS = ['claude_code', 'codex'] as const

const outOfUsage = (a: Account) => !!a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()

/** The account's most used window, as a whole percent: the limit it meets first. */
const highest = (a: Account) =>
  a.lastUsage?.length
    ? Math.min(100, Math.round(Math.max(...a.lastUsage.map((l) => l.utilization)) * 100))
    : null

/**
 * The avatar menu's Usage row: for each harness, its default account's most used limit at a
 * glance; hovered or tapped, every account's limits and when they reset. On a phone the sidebar
 * fills the screen and leaves no room beside it for a submenu, so the details unfold in the menu.
 */
export function UsageMenu({ accounts }: { accounts: Account[] | undefined }) {
  // The API lists each harness's default account first: the one new threads use.
  const summary = PROVIDERS.flatMap((provider) => {
    const a = accounts?.find((x) => x.provider === provider)
    if (!a) return []
    const out = outOfUsage(a)
    const percent = highest(a)
    return out || percent !== null ? [{ provider, out, percent }] : []
  })
  const reported = (accounts ?? []).filter((a) => outOfUsage(a) || a.lastUsage?.length)

  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)

  const row = (
    <>
      <Gauge />
      <span className="flex-1">Usage</span>
      {summary.map(({ provider, out, percent }) => (
        <span
          key={provider}
          className={cn(
            'flex items-center gap-1 text-xs tabular-nums',
            out || (percent ?? 0) >= 80 ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          <HarnessLogo harness={provider} className="size-3.5" />
          <span className="sr-only">{harnessLabel(provider)}</span>
          {out ? 'Out' : `${percent}%`}
        </span>
      ))}
    </>
  )

  if (mobile)
    return (
      <>
        <DropdownMenuItem
          aria-expanded={open}
          onSelect={(e) => {
            e.preventDefault()
            setOpen((o) => !o)
          }}
          className="gap-2"
        >
          {row}
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
        </DropdownMenuItem>
        {open && <UsageDetails reported={reported} />}
      </>
    )

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">{row}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 p-1">
        <UsageDetails reported={reported} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Every account's limits and when they reset, then where to see more. */
function UsageDetails({ reported }: { reported: Account[] }) {
  return (
    <>
      {reported.length === 0 && (
        <p className="text-muted-foreground px-2 py-1.5 text-sm">
          No usage reported yet. It shows after a teammate&apos;s next turn.
        </p>
      )}
      {reported.map((a) => (
        <div key={a.id} className="flex flex-col gap-2 px-2 py-1.5">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <HarnessLogo harness={a.provider} className="size-3.5" />
            <span className="truncate">{a.email ?? machineName(a.computer)}</span>
            {a.plan && (
              <span className="text-muted-foreground ml-auto shrink-0 text-xs capitalize">
                {a.plan}
              </span>
            )}
          </span>
          {outOfUsage(a) ? (
            <span className="text-warning text-xs">
              Out of usage until {resetLabel(a.exhaustedUntil)}
            </span>
          ) : (
            a.lastUsage && (
              <>
                <UsageMeters usage={a.lastUsage} className="sm:w-full" />
                <ResetLine usage={a.lastUsage} />
              </>
            )
          )}
        </div>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href="/app/usage">See what used it</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href="/app/accounts">Manage accounts</Link>
      </DropdownMenuItem>
    </>
  )
}

/** When the most used window resets: what the member wants to know once it runs high. */
function ResetLine({ usage }: { usage: NonNullable<Account['lastUsage']> }) {
  const top = usage.reduce((a, b) => (b.utilization > a.utilization ? b : a))
  if (!top.resetsAt) return null
  return <span className="text-muted-foreground text-xs">Resets {resetLabel(top.resetsAt)}</span>
}
