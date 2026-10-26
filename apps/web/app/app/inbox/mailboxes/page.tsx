'use client'
import { Suspense } from 'react'
import { MailboxesView } from '@/components/mailboxes'

/** Everything that receives mail for the workspace, and Add a mailbox. */
export default function MailboxesPage() {
  return (
    <Suspense>
      <MailboxesView />
    </Suspense>
  )
}
