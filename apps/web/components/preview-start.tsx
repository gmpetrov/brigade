'use client'
// Starting a thread's preview from the dashboard: the Preview button in a
// thread and on a pull request. The runner starts it without a turn when it
// can (again as it last ran, or from its repository's saved setup); else the
// teammate sets it up, after a dialog that says what that involves. The dialog
// shows the first time only, unless the person keeps it. A stopped workspace
// computer starts first: it asks again until the computer is up.
import type { PreviewStartOutcome } from '@brigade/contracts'
import { AppWindow, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/** While the workspace computer starts: how often to ask again, and for how long. */
const WAKING_POLL_MS = 3000
const WAKING_MAX_MS = 5 * 60_000

/** Set once a person said not to explain setting a preview up again, in this browser. */
const EXPLAINED_KEY = 'brigade:preview-setup-explained'

const explained = () => {
  try {
    return localStorage.getItem(EXPLAINED_KEY) === '1'
  } catch {
    return false
  }
}

type Asking =
  { kind: 'setup'; repository?: string } | { kind: 'teammate'; repository: string; reason: string }

/** What the teammate is asked when the runner cannot start the preview by itself. */
function request(asking: Asking) {
  if (asking.kind === 'teammate')
    return `Please start the preview of ${asking.repository} so I can try it.`
  return asking.repository
    ? `Please set up a preview of ${asking.repository} so I can try it, and save it.`
    : 'Please set up a preview of the app you are working on so I can try it, and save it.'
}

/**
 * Start a thread's preview. `onStarting` runs once it starts (or already
 * runs); `ask` sends the teammate a message when it has to set it up, and
 * `onAsked` runs after.
 */
export function usePreviewStart({
  threadId,
  teammateName,
  computer,
  repository,
  ask,
  onStarting,
  onAsked,
}: {
  threadId: string | undefined
  teammateName: string
  /** Where the thread runs: the workspace computer (cloud), or a member's machine. */
  computer?: { name: string; cloud: boolean }
  /** The repository to preview, when the page is about one (a pull request's). */
  repository?: string
  ask: (text: string) => Promise<unknown>
  onStarting: () => void
  onAsked?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [waking, setWaking] = useState(false)
  const [error, setError] = useState<string>()
  const [asking, setAsking] = useState<Asking>()
  // Gone from the page (or another thread): stop asking.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [threadId])

  async function send(next: Asking) {
    setBusy(true)
    setError(undefined)
    try {
      await ask(request(next))
      setAsking(undefined)
      onAsked?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    if (!threadId || busy) return
    setBusy(true)
    setError(undefined)
    let result: PreviewStartOutcome
    const since = Date.now()
    try {
      for (;;) {
        result = await api<PreviewStartOutcome>(`/threads/${threadId}/preview/start`, {
          body: repository ? { repository } : {},
        })
        if (result.outcome !== 'waking' || !mounted.current) break
        if (Date.now() - since > WAKING_MAX_MS)
          throw new Error('The cloud computer did not start. Try again in a minute.')
        setWaking(true)
        await new Promise((resolve) => setTimeout(resolve, WAKING_POLL_MS))
      }
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
      setWaking(false)
      return
    }
    setBusy(false)
    setWaking(false)
    if (result.outcome === 'waking') return
    if (result.outcome === 'started' || result.outcome === 'running') return onStarting()
    const next: Asking =
      result.outcome === 'teammate'
        ? { kind: 'teammate', repository: result.repository, reason: result.reason }
        : { kind: 'setup', repository: repository ?? result.repositories[0] }
    // Explained before and nothing new to say: ask right away.
    if (next.kind === 'setup' && explained()) return void send(next)
    setAsking(next)
  }

  const dialog = asking && (
    <PreviewSetupDialog
      asking={asking}
      teammateName={teammateName}
      computer={computer}
      busy={busy}
      error={error}
      onConfirm={() => void send(asking)}
      onClose={() => {
        setAsking(undefined)
        setError(undefined)
      }}
    />
  )

  return { start, busy, waking, error: asking ? undefined : error, dialog }
}

function PreviewSetupDialog({
  asking,
  teammateName,
  computer,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  asking: Asking
  teammateName: string
  computer?: { name: string; cloud: boolean }
  busy: boolean
  error?: string
  onConfirm: () => void
  onClose: () => void
}) {
  const [keep, setKeep] = useState(false)
  const what = asking.repository ?? 'the app'
  const setup = asking.kind === 'setup'

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppWindow aria-hidden className="size-5 text-muted-foreground" />
            {setup ? `Set up a preview of ${what}` : `Start the preview of ${what}`}
          </DialogTitle>
          <DialogDescription>
            {setup
              ? `${what === 'the app' ? 'The app' : what} has no saved preview yet, so ${teammateName} sets one up in this thread.`
              : `${asking.reason}. ${teammateName} starts it in this thread.`}
          </DialogDescription>
        </DialogHeader>

        {setup ? (
          <div className="flex flex-col gap-3 text-sm">
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-muted-foreground">
              <li>
                <span className="text-foreground">Installs and prepares the app:</span> its
                dependencies, a database in Docker, sample data.
              </li>
              <li>
                <span className="text-foreground">Starts it and opens its pages</span> as a person
                would, fixing what does not load.
              </li>
              <li>
                <span className="text-foreground">Saves how it starts.</span> From then on, Preview
                starts it in one step, without {teammateName}.
              </li>
            </ol>
            <p className="rounded-md bg-muted px-3 py-2 text-muted-foreground">
              The first time usually takes a few minutes, up to ten, and uses one of {teammateName}
              &apos;s turns.{' '}
              {computer && !computer.cloud
                ? `It runs on ${computer.name} and opens there only.`
                : 'It runs on the cloud computer, and anyone with its link can open it while it runs.'}{' '}
              It stops after 30 minutes nobody uses it.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            It starts as it was saved; the panel shows it once it does.
          </p>
        )}

        {error && <p className="text-sm text-destructive-text">{error}</p>}

        <DialogFooter className="items-center sm:justify-between">
          {setup ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="preview-explained"
                checked={keep}
                onCheckedChange={(checked) => setKeep(checked === true)}
              />
              <Label htmlFor="preview-explained" className="text-sm font-normal">
                Do not explain this again
              </Label>
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (keep)
                  try {
                    localStorage.setItem(EXPLAINED_KEY, '1')
                  } catch {}
                onConfirm()
              }}
            >
              {busy && <LoaderCircle aria-hidden className="animate-spin" />}
              {setup ? `Ask ${teammateName} to set it up` : `Ask ${teammateName} to start it`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
