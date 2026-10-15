import type { ReactNode } from 'react'
import { RedirectIfSignedIn } from '@/components/redirect-if-signed-in'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <RedirectIfSignedIn />
      {children}
    </>
  )
}
