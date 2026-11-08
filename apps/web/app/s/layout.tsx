import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { PRIVATE_PAGE } from '@/lib/page-metadata'

// Library files behind their public links: anyone with the address reads them, and no search
// engine lists them.
export const metadata: Metadata = { ...PRIVATE_PAGE, title: 'Shared with Brigade' }

export default function SharedLayout({ children }: { children: ReactNode }) {
  return children
}
