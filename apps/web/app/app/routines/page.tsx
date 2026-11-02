'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { ScheduleList } from '@/components/schedule-list'

export default function Routines() {
  return (
    <Suspense>
      <Filtered />
    </Suspense>
  )
}

/** `?project=<id|none>` opens it filtered, as a project's page links to it. */
function Filtered() {
  return <ScheduleList initialFilter={useSearchParams().get('project') ?? ''} />
}
