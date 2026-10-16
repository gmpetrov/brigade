'use client'
// Settings: the workspace's setup, one page per section with a nav beside them (above
// them on a phone). Opened from the member's menu or ⌘,; each section keeps its address.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { SETTINGS_NAV } from '@/components/dashboard'
import { cn } from '@/lib/utils'

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <nav aria-label="Settings" className="shrink-0 md:w-44">
        <p className="text-muted-foreground mb-2 hidden px-2.5 text-xs md:block">Settings</p>
        <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] md:mx-0 md:flex-col md:px-0">
          {SETTINGS_NAV.map(({ href, label, icon: Icon }) => {
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
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
