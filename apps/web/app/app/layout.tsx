import type { ReactNode } from 'react'
import { DashboardShell } from '@/components/dashboard'
import { EVERY_PAGE, sendAhead } from '@/lib/page-requests'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  // Asked for as the page arrives, before its scripts run.
  sendAhead(EVERY_PAGE)
  return <DashboardShell>{children}</DashboardShell>
}
