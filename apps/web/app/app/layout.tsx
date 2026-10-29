import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { DashboardShell } from '@/components/dashboard'
import { PRIVATE_PAGE } from '@/lib/page-metadata'

export const metadata: Metadata = PRIVATE_PAGE

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>
}
