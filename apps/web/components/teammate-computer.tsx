'use client'
// A teammate's computer, a page like any other (/app/teammates/<id>/computer): the
// workspace computer's screen, the threads panel docked beside it as on every page.
// The screen is the workspace's, the same for every teammate; control is a thread's.
// Through the thread open beside it when it runs there, else the one the teammate is
// working in there (or its newest): taking control there opens it beside the screen, where
// it waits for the hand back.
import { ComputerScreen } from '@/components/computer-panel'
import { useDashboard } from '@/components/dashboard'
import { DesktopScreen } from '@/components/desktop-preview'
import { useThreadPanel } from '@/components/thread-panel'
import { useApi, type Teammate, type Thread, type ThreadSummary } from '@/lib/api'
import { useLive } from '@/lib/use-live'

const BUSY = new Set(['starting', 'running'])

export function TeammateComputer({ teammate }: { teammate: Teammate }) {
  const { me } = useDashboard()
  const panel = useThreadPanel()
  const threads = useApi<ThreadSummary[]>(`/threads?teammateId=${teammate.id}`)
  const beside = panel.visible ? panel.threadId : null
  // The thread beside it, even when the list leaves it out (a child thread's), once it shows
  // it runs here: one on a member's Mac leaves control to the teammate's threads that do.
  const besideThread = useApi<Thread>(beside ? `/threads/${beside}` : null)
  const docked = besideThread.data?.id === beside ? besideThread.data : undefined
  const here = docked?.computer.kind === 'cloud'
  const cloud = threads.data?.filter((t) => t.computer.kind === 'cloud')
  const fallbackId = cloud?.find((t) => BUSY.has(t.status))?.id ?? cloud?.[0]?.id
  // Until the docked one loads, none: never another thread's Take control in the meantime.
  const loading = !!beside && !docked && !besideThread.error
  const controlId = here ? beside : loading ? undefined : fallbackId
  const thread = useApi<Thread>(controlId && !here ? `/threads/${controlId}` : null)
  const reloadThreads = threads.reload
  const reloadBeside = besideThread.reload
  const reloadThread = thread.reload
  useLive((message) => {
    if (message.type !== 'thread.updated') return
    void reloadThreads()
    void reloadBeside()
    void reloadThread()
  })
  const t = here ? docked : thread.data?.id === controlId ? thread.data : undefined
  // Closed, the conversation comes back from the screen's toolbar: a phone has no ⌘J.
  const reopen = panel.visible ? undefined : panel.toggle

  return (
    <div className="h-[calc(100svh-3rem)] min-h-0 md:h-svh">
      {t && t.computer.kind === 'cloud' ? (
        <ComputerScreen
          thread={t}
          memberId={me.memberId ?? ''}
          shell={panel.shell}
          onShell={panel.setShell}
          onChange={() => {
            void reloadBeside()
            void reloadThread()
            // The conversation beside the screen, for the hand back.
            if (beside !== t.id) panel.openThread(t.id)
          }}
          onCollapse={reopen}
        />
      ) : (
        // No thread on the workspace computer yet: its screen, to watch.
        <DesktopScreen
          source={{ teammate: teammate.id }}
          teammateName={teammate.name}
          control={false}
          mode="open"
          onCollapse={reopen}
        />
      )}
    </div>
  )
}
