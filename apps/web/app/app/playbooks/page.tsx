'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { PlaybookList } from '@/components/playbooks'

export default function Playbooks() {
  return (
    <Suspense>
      <Filtered />
    </Suspense>
  )
}

/** `?project=<id|none>` opens it filtered. */
function Filtered() {
  return <PlaybookList initialFilter={useSearchParams().get('project') ?? ''} />
}
