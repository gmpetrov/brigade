'use client'
import { useParams } from 'next/navigation'
import { MailboxView } from '@/components/mailboxes'

/** One mailbox: where its mail arrives, who handles it, who reads and replies. */
export default function MailboxPage() {
  const { id } = useParams<{ id: string }>()
  return <MailboxView id={decodeURIComponent(id)} />
}
