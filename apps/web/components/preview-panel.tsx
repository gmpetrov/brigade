'use client'
// The thread's live preview beside it: the app its teammate runs, in a frame,
// as the person's own browser renders it (not a picture of the computer's
// screen). Its state comes from the thread's preview.changed events; its
// address from the API, which hosts the port and hands out its token. While
// the panel is open it tells the API so, which keeps the preview running.
import type { PreviewInfo, PreviewView, SequencedEvent } from '@brigade/contracts'
import {
  AppWindow,
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  Power,
  RotateCw,
  ScrollText,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type ThreadPreview = PreviewInfo & { teammateId?: string }

/** How often an open panel says it is still open. Previews stop after 30 minutes unused. */
const TOUCH_MS = 2 * 60_000

/** The thread's preview, as its latest preview event says; undefined when it never had one. */
export function useThreadPreview(events: SequencedEvent[]): ThreadPreview | undefined {
  return useMemo(() => {
    const event = events.findLast((e) => e.event.type === 'preview.changed')?.event
    if (event?.type !== 'preview.changed') return undefined
    const { at: _at, type: _type, ...preview } = event
    return preview
  }, [events])
}

export const previewLive = (preview: ThreadPreview | undefined) =>
  preview?.status === 'starting' || preview?.status === 'running'

const STATUS: Record<PreviewInfo['status'], { label: string; dot: string }> = {
  starting: { label: 'Starting', dot: 'bg-warning animate-pulse' },
  running: { label: 'Running', dot: 'bg-success' },
  failed: { label: 'Failed', dot: 'bg-destructive' },
  stopped: { label: 'Stopped', dot: 'bg-muted-foreground' },
}

export function PreviewPanel({
  threadId,
  preview,
  teammateName,
  computerName,
  mayControl,
  onClose,
}: {
  threadId: string
  preview: ThreadPreview
  teammateName: string
  /** Where a preview on a member's own machine runs. */
  computerName: string
  mayControl: boolean
  onClose: () => void
}) {
  const [view, setView] = useState<PreviewView>()
  const [error, setError] = useState<string>()
  const [frame, setFrame] = useState(0)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<string>()
  const [showLogs, setShowLogs] = useState(false)
  const running = preview.status === 'running'

  // The address, once per run of the preview.
  useEffect(() => {
    if (!running) return setView(undefined)
    let live = true
    setError(undefined)
    api<PreviewView>(`/threads/${threadId}/preview`, { body: {} }).then(
      (v) => live && setView(v),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [threadId, preview.previewId, running])

  // Still open: keep it running.
  const live = previewLive(preview)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(
      () =>
        void api(`/threads/${threadId}/preview`, { body: { touch: true } }).catch(() => undefined),
      TOUCH_MS,
    )
    return () => clearInterval(timer)
  }, [threadId, live])

  const loadLogs = useCallback(async () => {
    try {
      setLogs((await api<{ text: string }>(`/threads/${threadId}/preview/logs`)).text)
    } catch (e) {
      setLogs((e as Error).message)
    }
  }, [threadId])

  useEffect(() => {
    if (showLogs && live) void loadLogs()
  }, [showLogs, live, preview.status, loadLogs])

  async function control(action: 'restart' | 'stop') {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/threads/${threadId}/preview/control`, { body: { action } })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const status = STATUS[preview.status]
  const address = view && !view.local ? new URL(view.url).host : `localhost:${preview.port}`

  return (
    <SidePanel aria-label="Preview" onClose={onClose}>
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <AppWindow aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="flex items-center gap-1.5 text-sm font-semibold">
            <span className={cn('size-2 shrink-0 rounded-full', status.dot)} aria-hidden />
            Preview
            <span className="font-normal text-muted-foreground">
              · {status.label} · :{preview.port}
            </span>
          </strong>
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={`${preview.cwd ? `${preview.cwd}$ ` : ''}${preview.command}`}
          >
            {preview.command}
          </span>
        </div>
        {view && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              title="Reload the page"
              onClick={() => setFrame((n) => n + 1)}
            >
              <RotateCw aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={copied ? 'Copied' : 'Copy link'}
              title={
                copied ? 'Copied' : 'Copy link: anyone with it can open the preview while it runs'
              }
              onClick={() =>
                void navigator.clipboard.writeText(view.url).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </Button>
            <Button asChild variant="ghost" size="icon-sm" title="Open in a new tab">
              <a
                href={view.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in a new tab"
              >
                <ExternalLink aria-hidden />
              </a>
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={showLogs}
          aria-label={showLogs ? 'Hide output' : 'Show output'}
          title={showLogs ? 'Hide output' : "Show the app's output"}
          disabled={!live}
          onClick={() => setShowLogs(!showLogs)}
        >
          <ScrollText aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close preview"
          title="Close"
        >
          <X aria-hidden />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {running && view ? (
          <>
            {view.local && (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
                The app runs on {computerName}, so it opens there only, at{' '}
                <span className="font-mono text-foreground">{address}</span>.
              </p>
            )}
            <iframe
              key={`${preview.previewId}:${frame}`}
              src={view.url}
              title={`Preview of the app ${teammateName} runs`}
              className="min-h-0 w-full flex-1 border-0 bg-white"
              // Its own origin, apart from the dashboard's: scripts and forms run as they would in a tab.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              allow="clipboard-read; clipboard-write; fullscreen"
              referrerPolicy="no-referrer"
            />
            {!view.local && (
              // Some sign-ins refuse a frame on another site (Google, GitHub), and Safari keeps no cookies there.
              <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                Signing in does not work here?{' '}
                <a
                  href={view.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Open it in a new tab
                </a>
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            {preview.status === 'starting' || (running && !view && !error) ? (
              <>
                <LoaderCircle aria-hidden className="size-5 animate-spin" />
                <p>
                  {running ? 'Opening the preview…' : `Starting the app on port ${preview.port}…`}
                </p>
              </>
            ) : running ? null : (
              <>
                <p className="font-medium text-foreground">
                  {preview.status === 'failed' ? 'The preview failed' : 'The preview stopped'}
                </p>
                {preview.reason && <p>{preview.reason}</p>}
                <p>Ask {teammateName} to start it again.</p>
              </>
            )}
            {error && <p className="text-destructive-text">{error}</p>}
          </div>
        )}

        {showLogs && (
          <div className="flex max-h-[40%] min-h-32 flex-col border-t">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span className="flex-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Output
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Refresh"
                aria-label="Refresh output"
                onClick={() => void loadLogs()}
              >
                <RotateCw aria-hidden />
              </Button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap">
              {logs ?? 'Loading…'}
            </pre>
          </div>
        )}

        {mayControl && live && (
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            {running && error && <p className="text-xs text-destructive-text">{error}</p>}
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void control('restart')}
            >
              <Power aria-hidden />
              Restart
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void control('stop')}
            >
              <Square aria-hidden />
              Stop
            </Button>
          </div>
        )}
      </div>
    </SidePanel>
  )
}
