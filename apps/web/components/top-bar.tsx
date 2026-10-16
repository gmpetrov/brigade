'use client'
// On a phone, at the top of every page: the button that opens the sidebar and the threads
// panel's button, with no bar behind them: they scroll away with the page, as a thread
// floats its own. Each page has its own title. On a wider screen there is none: the
// sidebar is always there (⌘B folds it) and ⌘J opens the threads panel.
import { SidebarToggle } from '@/components/dashboard'
import { ThreadsButton } from '@/components/thread-panel'

export function TopBar() {
  return (
    <div data-top-bar className="flex h-12 shrink-0 items-center justify-between px-4 md:hidden">
      <SidebarToggle />
      <ThreadsButton />
    </div>
  )
}
