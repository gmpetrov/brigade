'use client'
// Settings: the member's own, then the workspace's, then what teammates work with, one page per section with a
// nav beside them, in titled groups (above them on a phone, in one row). Opened from the member's menu or ⌘,; each section keeps its address.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { SETTINGS_GROUPS } from '@/components/dashboard'
import { cn } from '@/lib/utils'

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <nav
        aria-label="Settings"
        className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none] md:mx-0 md:w-44 md:flex-col md:gap-5 md:px-0"
      >
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="contents md:block">
            <p className="text-muted-foreground mb-1 hidden px-2.5 text-xs md:block">
              {group.label}
            </p>
            <ul className="contents md:flex md:flex-col md:gap-1">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = pathname.startsWith(href)
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors [&>svg]:size-4',
                        active
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      )}
                    >
                      <Icon aria-hidden />
                      {label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
