'use client'
// A teammate's computer, a page like any other (/app/teammates/<id>/computer): the
// workspace computer's screen, the threads panel docked beside it as on every page.
// The screen is the workspace's, the same for every teammate; control is a thread's.
// Through the thread open beside it when the teammate is in it, else the one the
// teammate is working in (or its newest): taking control there opens it beside the
// screen, where it waits for the hand back.
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
  const controlId =
    threads.data?.find((t) => t.id === beside)?.id ??
    threads.data?.find((t) => BUSY.has(t.status))?.id ??
    threads.data?.[0]?.id
  const thread = useApi<Thread>(controlId ? `/threads/${controlId}` : null)
  const reloadThreads = threads.reload
  const reloadThread = thread.reload
  useLive((message) => {
    if (message.type !== 'thread.updated') return
    void reloadThreads()
    void reloadThread()
  })
  const t = thread.data?.id === controlId ? thread.data : undefined

  return (
    <div className="h-[calc(100svh-3rem)] min-h-0">
      {t && t.computer.kind === 'cloud' ? (
        <ComputerScreen
          thread={t}
          memberId={me.memberId ?? ''}
          status={t.status}
          shell={panel.shell}
          onShell={panel.setShell}
          onChange={() => {
            void reloadThread()
            // The conversation beside the screen, for the hand back.
            if (beside !== t.id) panel.openThread(t.id)
          }}
        />
      ) : (
        // No thread on the workspace computer yet: its screen, to watch.
        <DesktopScreen
          source={{ teammate: teammate.id }}
          teammateName={teammate.name}
          control={false}
          mode="open"
        />
      )}
    </div>
  )
}
