'use client'
import { TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { reportError } from '@/lib/error-reports'

/** A page of the dashboard that failed to show: reported, with a way to try again. */
export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => reportError(error, 'boundary'), [error])
  return (
    <section className="m-6 flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <TriangleAlert className="size-6" aria-hidden />
      </span>
      <h2 className="text-lg font-bold">This page hit an error</h2>
      <p className="max-w-md text-sm text-muted-foreground">Try again, or reload the page.</p>
      <Button onClick={() => retry()}>Try again</Button>
    </section>
  )
}
