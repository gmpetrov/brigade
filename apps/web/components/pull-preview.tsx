'use client'
// A pull request's preview: try the change beside it, without going to its
// thread. A pull request a teammate opened previews in that thread (its
// branch is checked out there): started without a turn when its repository
// has a saved preview, else its teammate sets one up. One opened outside
// Brigade gets a thread first, where a teammate checks out its branch and
// starts it; that thread becomes the pull request's.
import type { PullRequestDetail, ThreadPreviewState } from '@brigade/contracts'
import { AppWindow, LoaderCircle } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import {
  PHASE,
  PREVIEW_PANEL,
  PreviewPanel,
  previewLive,
  previewPhase,
} from '@/components/preview-panel'
import { usePreviewStart } from '@/components/preview-start'
import { panelInFront, raisePanel, usePanelInFront } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type Teammate } from '@/lib/api'
import { cn } from '@/lib/utils'

/** How often its thread's preview is read: often while it starts or is open, else now and then. */
const ACTIVE_MS = 3000
const IDLE_MS = 30_000

/** The Preview button for a pull request's action row, with its panel and dialogs. */
export function PullPreview({
  pull,
  path,
  onReload,
}: {
  pull: PullRequestDetail
  /** The pull request's API path. */
  path: string
  onReload: () => Promise<unknown>
}) {
  const { teammates } = useDashboard()
  const sessionId = pull.tracking?.sessionId ?? undefined
  const [state, setState] = useState<ThreadPreviewState>()
  const [open, setOpen] = useState(false)
  // Open behind the threads panel, it is not what shows.
  const inFront = usePanelInFront(PREVIEW_PANEL)
  // Started or asked for: the panel opens once it starts.
  const [awaiting, setAwaiting] = useState(false)
  const [asked, setAsked] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string>()

  const preview = state?.preview ?? undefined
  const live = previewLive(preview)
  const phase = preview && previewPhase(preview)

  const read = useCallback(async () => {
    if (!sessionId) return setState(undefined)
    try {
      setState(await api<ThreadPreviewState>(`/threads/${sessionId}/preview/state`))
    } catch {
      // Read again on the next tick.
    }
  }, [sessionId])
  const active =
    open || awaiting || phase === 'setup' || phase === 'starting' || phase === 'checking'
  useEffect(() => {
    void read()
    const timer = setInterval(() => void read(), active ? ACTIVE_MS : IDLE_MS)
    return () => clearInterval(timer)
  }, [read, active])

  useEffect(() => {
    if (!awaiting || !live) return
    setAwaiting(false)
    setAsked(undefined)
    setOpen(true)
  }, [awaiting, live])

  const teammateName = state?.teammateName ?? pull.tracking?.author?.name ?? 'The teammate'
  const ask = async (text: string) => {
    if (!sessionId) return
    await api(`/threads/${sessionId}/messages`, { body: { text } })
    setAsked(teammateName)
  }
  const start = usePreviewStart({
    threadId: sessionId,
    teammateName,
    ...(state ? { computer: { name: state.computerName, cloud: state.cloud } } : {}),
    repository: pull.repository,
    ask,
    onStarting: () => {
      if (live) setOpen(true)
      else setAwaiting(true)
      void read()
    },
    onAsked: () => setAwaiting(true),
  })

  function onClick() {
    setError(undefined)
    if (open) return panelInFront(PREVIEW_PANEL) ? setOpen(false) : raisePanel(PREVIEW_PANEL)
    if (live) return setOpen(true)
    if (!sessionId) return setPicking(true)
    if (preview) setOpen(true)
    void start.start()
  }

  const shownError = error ?? start.error
  return (
    <>
      <Button
        variant="outline"
        aria-pressed={open && inFront}
        disabled={start.busy}
        onClick={onClick}
        title={live ? 'Try the change beside the pull request' : 'Run the change to try it here'}
      >
        {start.busy ? <LoaderCircle className="animate-spin" /> : <AppWindow />}
        Preview
        {preview && live && phase && (
          <span
            className={cn('size-1.5 rounded-full', PHASE[phase].dot)}
            aria-label={PHASE[phase].label}
            role="img"
          />
        )}
      </Button>

      {(asked || shownError) && (
        <p
          className={cn(
            'basis-full text-sm',
            shownError ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          {shownError ?? (
            <>
              Asked {asked} to {preview ? 'start' : 'set up'} the preview. It opens here once it
              starts
              {sessionId && (
                <>
                  ;{' '}
                  <Link
                    href={`/app/threads/${sessionId}`}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    follow it in the thread
                  </Link>
                </>
              )}
              .
            </>
          )}
        </p>
      )}

      {open && preview && sessionId && state && (
        <PreviewPanel
          threadId={sessionId}
          preview={preview}
          teammateName={state.teammateName}
          computerName={state.computerName}
          mayControl={state.mayControl}
          onClose={() => setOpen(false)}
          onStart={() => void start.start()}
          starting={start.busy}
          onAsk={
            state.mayControl
              ? (text) => void ask(text).catch((e: Error) => setError(e.message))
              : undefined
          }
          expectedCommit={pull.headSha}
        />
      )}
      {start.dialog}

      {picking && (
        <PickTeammate
          pull={pull}
          teammates={teammates}
          onClose={() => setPicking(false)}
          onPick={async (teammateId) => {
            await api(`${path}/preview`, { body: { teammateId } })
            setPicking(false)
            setAsked(teammates.find((t) => t.id === teammateId)?.name ?? 'a teammate')
            setAwaiting(true)
            await onReload()
          }}
        />
      )}
    </>
  )
}

/** A pull request with no thread: who checks out its branch and starts its preview. */
function PickTeammate({
  pull,
  teammates,
  onClose,
  onPick,
}: {
  pull: PullRequestDetail
  teammates: Teammate[]
  onClose: () => void
  onPick: (teammateId: string) => Promise<void>
}) {
  const [teammateId, setTeammateId] = useState(teammates[0]?.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppWindow aria-hidden className="size-5 text-muted-foreground" />
            Preview #{pull.number}
          </DialogTitle>
          <DialogDescription>
            A teammate checks out <code className="font-mono text-xs">{pull.head}</code> in a new
            thread and starts the app there, from {pull.repository}&apos;s saved preview or by
            setting one up. Setting one up takes a few minutes the first time.
          </DialogDescription>
        </DialogHeader>
        {teammates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No teammate yet.{' '}
            <Link
              href="/app/teammates/new"
              className="text-primary underline-offset-4 hover:underline"
            >
              Add one
            </Link>
            .
          </p>
        ) : (
          <Select value={teammateId} onValueChange={setTeammateId}>
            <SelectTrigger aria-label="Teammate" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {teammates.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <TeammateAvatar teammate={m} className="size-5" />
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !teammateId}
            onClick={() => {
              if (!teammateId) return
              setBusy(true)
              setError(undefined)
              onPick(teammateId)
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false))
            }}
          >
            {busy && <LoaderCircle aria-hidden className="animate-spin" />}
            Start the preview
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
