'use client'
import { Suspense } from 'react'
import { InboxView } from '@/components/inbox'

/** Every email the workspace's mailboxes received, and where each went. */
export default function InboxPage() {
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  )
}
