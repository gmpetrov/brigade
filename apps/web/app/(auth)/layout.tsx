import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { RedirectIfSignedIn } from '@/components/redirect-if-signed-in'
import { PRIVATE_PAGE } from '@/lib/page-metadata'

export const metadata: Metadata = PRIVATE_PAGE

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <RedirectIfSignedIn />
      {children}
    </>
  )
}
