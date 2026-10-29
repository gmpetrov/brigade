import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { PRIVATE_PAGE } from '@/lib/page-metadata'

export const metadata: Metadata = PRIVATE_PAGE

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return children
}
