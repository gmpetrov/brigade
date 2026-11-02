'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { PullList } from '@/components/pull-list'

export default function PullRequests() {
  return (
    <Suspense>
      <Filtered />
    </Suspense>
  )
}

/** `?project=<id|none>` opens it filtered, as a project's page links to it. */
function Filtered() {
  return <PullList initialFilter={useSearchParams().get('project') ?? ''} />
}
