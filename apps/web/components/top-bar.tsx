'use client'
// On a phone, across the top of every page: the button that opens the sidebar, where you
// are, and the threads panel's button. On a wider screen there is none: the sidebar is
// always there (⌘B folds it), ⌘J opens the threads panel, and each page has its title.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment } from 'react'
import { NAV, SidebarToggle, useDashboard } from '@/components/dashboard'
import { PROJECT_TABS } from '@/components/project-shell'
import { ThreadsButton } from '@/components/thread-panel'

type Crumb = { label: string; href?: string }

/** The trail to a page from its address: the section, then what it shows. */
function useCrumbs(): Crumb[] {
  const pathname = usePathname()
  const { projects, teammates } = useDashboard()
  const [, , section, id, ...rest] = pathname.split('/')
  if (!section) return [{ label: 'Home' }]
  const nav = NAV.find((n) => n.href === `/app/${section}`)
  if (section === 'projects') {
    const crumbs: Crumb[] = [{ label: 'Projects', href: '/app/projects' }]
    if (!id) return crumbs
    const tab = PROJECT_TABS.find((t) => t.path === (rest[0] ? `/${rest[0]}` : ''))
    crumbs.push({
      label: projects.find((p) => p.id === id)?.name ?? 'Project',
      href: `/app/projects/${id}`,
    })
    if (tab?.path) crumbs.push({ label: tab.label })
    return crumbs
  }
  if (section === 'teammates')
    return [
      { label: 'AI teammates' },
      {
        label: id === 'new' ? 'New' : (teammates.find((t) => t.id === id)?.name ?? 'Teammate'),
        href: `/app/teammates/${id}`,
      },
      ...(id === 'new' ? [] : [{ label: rest[0] === 'computer' ? 'Computer' : 'Settings' }]),
    ]
  if (section === 'pulls' && id)
    return [
      { label: 'Pull requests', href: '/app/pulls' },
      {
        label: `${id}/${rest[0] ?? ''}`,
        href: rest[1] ? `/app/pulls/${id}/${rest[0]}` : undefined,
      },
      ...(rest[1] ? [{ label: `#${rest[1]}` }] : []),
    ]
  if (section === 'threads' && rest[0] === 'log')
    return [{ label: 'Thread', href: `/app/threads/${id}` }, { label: 'Run log' }]
  return [{ label: nav?.label ?? section }]
}

export function TopBar() {
  const crumbs = useCrumbs()
  return (
    <header
      data-top-bar
      className="sticky top-0 z-10 flex h-12 md:hidden shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6"
    >
      <SidebarToggle />
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <Fragment key={i}>
                {i > 0 && <li aria-hidden>/</li>}
                <li className={last ? 'min-w-0 truncate font-medium text-foreground' : 'shrink-0'}>
                  {c.href && !last ? (
                    <Link href={c.href} className="hover:text-foreground">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current={last ? 'page' : undefined}>{c.label}</span>
                  )}
                </li>
              </Fragment>
            )
          })}
        </ol>
      </nav>
      <ThreadsButton />
    </header>
  )
}
