'use client'
// A teammate's settings: who it is, what it may reach and spend, and what it is up to. Its
// threads are where the sidebar takes you (components/thread-panel.tsx).
import { modelLabel } from '@brigade/contracts'
import { Archive } from 'lucide-react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { TeammateAccess } from '@/components/teammate-access'
import { TeammateForm } from '@/components/teammate-form'
import { TeammateTitle } from '@/components/teammate-title'
import { TeammateCaps, TeammateStatus, useTeammateTimeline } from '@/components/teammate-oversight'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, harnessLabel } from '@/lib/api'

type Tab = 'profile' | 'access' | 'activity' | 'limits'

export default function TeammatePage() {
  return (
    <Suspense>
      <TeammateView />
    </Suspense>
  )
}

function TeammateView() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const params = useSearchParams()
  const { me, teammates, reloadTeammates } = useDashboard()
  const teammate = teammates.find((t) => t.id === id)
  const oversight = useTeammateTimeline(id)

  // ?tab= keeps the open tab across reloads and links; Profile is for admins only.
  const tabs: Tab[] = isAdmin(me)
    ? ['profile', 'access', 'activity', 'limits']
    : ['access', 'activity', 'limits']
  const asked = params.get('tab') as Tab | null
  const tab = asked && tabs.includes(asked) ? asked : tabs[0]!
  function openTab(next: string) {
    router.replace(next === tabs[0] ? `/app/teammates/${id}` : `/app/teammates/${id}?tab=${next}`, {
      scroll: false,
    })
  }

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
            <TeammateTitle title={teammate.title} />
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
          {!isAdmin(me) && teammate.instructions && (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">
              {teammate.instructions}
            </p>
          )}
        </div>
      </header>
      <Tabs value={tab} onValueChange={openTab} className="gap-5">
        <TabsList variant="line" className="border-b w-full justify-start rounded-none">
          {isAdmin(me) && (
            <TabsTrigger value="profile" className="flex-none">
              Profile
            </TabsTrigger>
          )}
          <TabsTrigger value="access" className="flex-none">
            Access
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex-none">
            Activity
          </TabsTrigger>
          <TabsTrigger value="limits" className="flex-none">
            Limits
          </TabsTrigger>
        </TabsList>

        <div className="max-w-3xl">
          {isAdmin(me) && (
            // Kept mounted so unsaved edits survive a look at another tab.
            <TabsContent value="profile" forceMount className="data-[state=inactive]:hidden">
              <TeammateForm
                initial={teammate}
                submitLabel="Save"
                onSubmit={async (input) => {
                  await api(`/teammates/${id}`, { method: 'PATCH', body: input })
                  await reloadTeammates()
                }}
                footer={
                  teammate.kind !== 'chief' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-ml-2 text-destructive-text hover:text-destructive-text"
                      onClick={archive}
                    >
                      <Archive aria-hidden />
                      Archive
                    </Button>
                  )
                }
              />
            </TabsContent>
          )}

          <TabsContent value="access">
            <TeammateAccess
              teammate={teammate}
              editable={isAdmin(me)}
              onPolicyChange={() => void reloadTeammates()}
            />
          </TabsContent>

          <TabsContent value="activity">
            <TeammateStatus {...oversight} />
          </TabsContent>

          <TabsContent value="limits">
            <TeammateCaps
              teammate={teammate}
              usage={oversight.timeline.data?.usage}
              editable={isAdmin(me)}
              onSaved={() => {
                void reloadTeammates()
                oversight.refresh()
              }}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
