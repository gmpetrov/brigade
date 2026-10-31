import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ErrorReports } from '@/components/error-reports'
import { PRIVATE_PAGE } from '@/lib/page-metadata'

export const metadata: Metadata = PRIVATE_PAGE

export default function InviteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ErrorReports />
      {children}
    </>
  )
}
