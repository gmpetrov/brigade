'use client'
import { Check, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useApi, type ConnectionsResponse, type Task, type ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

const dismissedKey = (workspaceId: string) => `brigade.checklist.dismissed.${workspaceId}`

/**
 * The first steps in a workspace, worked out from what it has: an AI account
 * (always, past onboarding), a team set up with the chief, a connection, and
 * a teammate's first finished work. Gone once all are done, or dismissed.
 */
export function GettingStarted({ threads }: { threads: ThreadSummary[] | undefined }) {
  const { me, teammates } = useDashboard()
  const workspaceId = me.activeWorkspaceId!
  const connections = useApi<ConnectionsResponse>('/connections')
  const tasks = useApi<Task[]>('/tasks')
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(dismissedKey(workspaceId)) === '1')
    } catch {
      setDismissed(false)
    }
  }, [workspaceId])

  if (dismissed || !threads || !connections.data || !tasks.data) return null

  const chief = teammates.find((t) => t.kind === 'chief')
  const team = teammates.filter((t) => t.kind !== 'chief')
  const ids = new Set(team.map((t) => t.id))
  const chiefThread = threads.find((t) => t.teammate.id === chief?.id)
  const steps = [
    { label: 'Connect your AI account', done: true },
    {
      label: 'Set up your team with Chief',
      done: team.length > 0,
      href: chiefThread ? `/app/threads/${chiefThread.id}` : undefined,
      action: chiefThread ? 'Continue' : undefined,
      hint: chiefThread ? undefined : 'Ask Chief below to help you set up your team.',
    },
    {
      label: 'Connect a tool your team works in',
      done: connections.data.connections.some((c) => c.status !== 'removed'),
      href: '/app/connections',
      action: 'Connect',
    },
    {
      label: 'Get a first piece of work done',
      // A finished task, or a teammate's own thread done; one only joining the chief's is not yet.
      done:
        tasks.data.some((t) => t.column === 'done') ||
        threads.some((t) => t.status === 'idle' && ids.has(t.teammate.id)),
      hint: team.length > 0 ? 'Give one of your teammates a small task below.' : undefined,
    },
  ]
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(dismissedKey(workspaceId), '1')
    } catch {}
  }

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="font-bold">Get started</h2>
          <p className="text-sm text-muted-foreground">
            {done} of {steps.length} done
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Hide getting started"
          onClick={dismiss}
        >
          <X aria-hidden />
        </Button>
      </div>
      <Progress value={(done / steps.length) * 100} aria-label="Getting started progress" />
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => {
          // The first step not done is the one to do now.
          const next = !s.done && steps.findIndex((x) => !x.done) === i
          return (
            <li
              key={s.label}
              className={cn('flex items-center gap-3 rounded-md px-2 py-2', next && 'bg-accent/60')}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  s.done ? 'border-success/40 bg-success/15 text-success' : 'text-muted-foreground',
                )}
              >
                {s.done ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className={cn(
                    'text-sm font-medium',
                    s.done && 'text-muted-foreground line-through',
                  )}
                >
                  {s.label}
                </span>
                {next && s.hint && <span className="text-xs text-muted-foreground">{s.hint}</span>}
              </div>
              {!s.done && s.href && s.action && (
                <Button asChild size="sm" variant={next ? 'default' : 'outline'}>
                  <Link href={s.href}>{s.action}</Link>
                </Button>
              )}
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
