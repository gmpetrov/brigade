'use client'
import { modelLabel } from '@brigade/contracts'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { NewThread } from '@/components/new-thread'
import { TeammateAccess } from '@/components/teammate-access'
import { TeammateBrowser } from '@/components/teammate-browser'
import { TeammateForm } from '@/components/teammate-form'
import { TeammateCaps, TeammateStatus, useTeammateTimeline } from '@/components/teammate-oversight'
import { ThreadList } from '@/components/thread-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, harnessLabel, useApi, type ComputersResponse, type ThreadSummary } from '@/lib/api'

export default function TeammatePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { me, teammates, reloadTeammates } = useDashboard()
  const teammate = teammates.find((t) => t.id === id)
  const threads = useApi<ThreadSummary[]>(`/threads?teammateId=${id}`)
  const computers = useApi<ComputersResponse>('/computers')
  const [editing, setEditing] = useState(false)
  const oversight = useTeammateTimeline(id)

  if (!teammate) return <p className="text-sm text-muted-foreground">Loading…</p>

  async function archive() {
    if (!confirm(`Archive ${teammate!.name}? Its threads stay in the run log.`)) return
    await api(`/teammates/${id}`, { method: 'DELETE' })
    await reloadTeammates()
    router.push('/app')
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-center gap-4">
        <TeammateAvatar teammate={teammate} className="size-16 text-2xl" />
        <div className="flex flex-[1_1_16rem] flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-3xl font-extrabold tracking-tight">{teammate.name}</h1>
            <Badge
              className={
                teammate.harness === 'codex'
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-primary/15 text-primary'
              }
            >
              {harnessLabel(teammate.harness)} · {modelLabel(teammate.harness, teammate.model)}
            </Badge>
          </div>
          {!editing && teammate.instructions && (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">
              {teammate.instructions}
            </p>
          )}
        </div>
        {isAdmin(me) && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(!editing)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            <Button variant="danger" onClick={archive}>
              Archive
            </Button>
          </div>
        )}
      </header>
      {editing && (
        <TeammateForm
          initial={teammate}
          submitLabel="Save"
          onSubmit={async (input) => {
            await api(`/teammates/${id}`, { method: 'PATCH', body: input })
            await reloadTeammates()
            setEditing(false)
          }}
        />
      )}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-5">
          <section aria-labelledby="new-thread" className="flex flex-col gap-3">
            <h2 id="new-thread" className="text-base font-bold">
              New thread
            </h2>
            <NewThread teammate={teammate} rows={4} />
          </section>

          <TeammateAccess
            teammate={teammate}
            editable={isAdmin(me)}
            onPolicyChange={() => void reloadTeammates()}
          />

          <TeammateBrowser
            teammate={teammate}
            computer={computers.data?.computers.find(
              (c) => c.kind === 'cloud' && !['destroyed', 'error'].includes(c.status),
            )}
          />

          <TeammateCaps
            teammate={teammate}
            usage={oversight.timeline.data?.usage}
            editable={isAdmin(me)}
            onSaved={() => {
              void reloadTeammates()
              oversight.refresh()
            }}
          />
        </div>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <TeammateStatus {...oversight} />
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-bold">Threads</h2>
            {threads.data && <ThreadList threads={threads.data} showTeammate={false} />}
          </section>
        </div>
      </div>
    </div>
  )
}
