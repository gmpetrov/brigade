'use client'
import { ArrowRight, UserPlus } from 'lucide-react'
import Link from 'next/link'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { ThreadList } from '@/components/thread-list'
import { Button } from '@/components/ui/button'
import { harnessLabel, useApi, type ThreadSummary } from '@/lib/api'

export default function Home() {
  const { me, teammates } = useDashboard()
  const threads = useApi<ThreadSummary[]>('/threads')
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">{workspace?.name}</h1>
        <p className="text-muted-foreground">
          Everything your AI teammates are working on, newest first.
        </p>
      </header>
      {teammates.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-12 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <UserPlus className="size-6" aria-hidden />
          </span>
          <h2 className="text-lg font-bold">Add your first AI teammate</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            A teammate is a saved identity with its own instructions. Every message to it opens a
            thread.
          </p>
          {isAdmin(me) ? (
            <Button asChild className="mt-1">
              <Link href="/app/teammates/new">New teammate</Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Ask an owner or admin to add one.</p>
          )}
        </section>
      ) : (
        <section
          aria-label="Start a thread"
          className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4"
        >
          {teammates.map((t) => (
            <Link
              key={t.id}
              href={`/app/teammates/${t.id}`}
              className="group flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent/50"
            >
              <TeammateAvatar teammate={t} className="size-11 text-base" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-bold">Message {t.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {harnessLabel(t.harness)}
                </span>
              </span>
              <ArrowRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          ))}
        </section>
      )}
      <section aria-labelledby="recent-threads" className="flex flex-col gap-3">
        <h2 id="recent-threads" className="text-lg font-bold">
          Recent threads
        </h2>
        {threads.data && <ThreadList threads={threads.data} />}
      </section>
    </div>
  )
}
