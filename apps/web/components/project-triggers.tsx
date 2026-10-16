'use client'
import { Zap } from 'lucide-react'
import Link from 'next/link'
import { useApi, type Trigger } from '@/lib/api'

/** A project's triggers: each event starts a thread in it. They are set up on Apps. */
export function ProjectTriggers({ projectId }: { projectId: string }) {
  const triggers = useApi<Trigger[]>(`/triggers?project=${projectId}`)
  return (
    <section aria-labelledby="project-triggers" className="flex flex-col gap-3">
      <h2 id="project-triggers" className="flex items-center gap-2 text-sm font-bold">
        <Zap className="size-4 text-muted-foreground" aria-hidden />
        Triggers
      </h2>
      {triggers.data && triggers.data.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No trigger starts threads in this project. Add one on{' '}
          <Link href="/app/connections" className="font-medium text-primary hover:underline">
            Apps
          </Link>{' '}
          and choose this project.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {(triggers.data ?? []).map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <span className="font-semibold">{t.label}</span>
              <span className="text-muted-foreground">→ {t.teammate.name}</span>
              <Link
                href="/app/connections"
                className="ml-auto text-xs text-muted-foreground hover:underline"
              >
                On Apps
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
