'use client'
// The thread's live preview beside it: the app its teammate runs, in a frame,
// as the person's own browser renders it (not a picture of the computer's
// screen). Its state comes from the thread's preview.changed events (or, on a
// pull request, its thread's preview state); its address from the API, which
// hosts the port and hands out its token. While the panel is open it tells the
// API so, which keeps the preview running. Starting, it says what it is doing
// and the app's latest output; running, whether its pages passed their check.
import {
  previewReady,
  type PreviewInfo,
  type PreviewView,
  type SequencedEvent,
  type ThreadPreviewState,
} from '@brigade/contracts'
import {
  AppWindow,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  Play,
  Power,
  RotateCw,
  ScrollText,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'

/** The preview's name among the panels beside a page. */
export const PREVIEW_PANEL = 'preview'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type ThreadPreview = PreviewInfo & { teammateId?: string }

/** How often an open panel says it is still open. Previews stop after 30 minutes unused. */
const TOUCH_MS = 2 * 60_000
/** How often a starting preview's latest output is read. */
const TAIL_MS = 2000

/** The thread's preview, as its latest preview event says; undefined when it never had one. */
export function useThreadPreview(events: SequencedEvent[]): ThreadPreview | undefined {
  return useMemo(() => {
    const event = events.findLast((e) => e.event.type === 'preview.changed')?.event
    if (event?.type !== 'preview.changed') return undefined
    const { at: _at, type: _type, ...preview } = event
    return preview
  }, [events])
}

/** How often a preview its events say runs is checked against its computer. */
const CHECK_MS = 30_000

/**
 * The thread's preview as its events say, unless the API says it cannot be
 * running: its computer stopped or went offline, which the events never say.
 */
export function useCheckedPreview(
  threadId: string,
  preview: ThreadPreview | undefined,
): ThreadPreview | undefined {
  const [ended, setEnded] = useState<{ key: string; preview: ThreadPreview }>()
  const live = previewLive(preview)
  const previewId = preview?.previewId
  const key = preview ? `${preview.previewId}:${preview.status}` : ''
  useEffect(() => {
    if (!live) return
    let current = true
    const check = () =>
      api<ThreadPreviewState>(`/threads/${threadId}/preview/state`).then(
        ({ preview: checked }) => {
          if (!current) return
          setEnded(
            checked && checked.previewId === previewId && !previewLive(checked)
              ? { key, preview: checked }
              : undefined,
          )
        },
        () => undefined,
      )
    void check()
    const timer = setInterval(() => void check(), CHECK_MS)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [threadId, key, previewId, live])
  return ended?.key === key ? ended.preview : preview
}

/** The repositories the thread's teammates have checked out: each teammate's latest report. */
export function useThreadRepositories(events: SequencedEvent[]): string[] {
  return useMemo(() => {
    const latest = new Map<string, string[]>()
    for (const { event } of events)
      if (event.type === 'repositories.changed')
        latest.set(event.teammateId ?? '', event.repositories)
    return [...new Set([...latest.values()].flat())].sort()
  }, [events])
}

export const previewLive = (preview: ThreadPreview | undefined) =>
  preview?.status === 'starting' || preview?.status === 'running'

/**
 * Where a preview stands, for people: running its setup, starting, checking
 * its pages, ready, or running with pages that failed their check.
 * `running` is one nobody checked (from an older runner, or a check that could not run).
 */
export type PreviewPhase =
  'setup' | 'starting' | 'checking' | 'ready' | 'attention' | 'running' | 'failed' | 'stopped'

export function previewPhase(preview: ThreadPreview): PreviewPhase {
  if (preview.status === 'starting') return preview.step === 'setup' ? 'setup' : 'starting'
  if (preview.status !== 'running') return preview.status
  if (preview.check?.status === 'checking') return 'checking'
  if (preview.check?.status === 'failed') return 'attention'
  return previewReady(preview) ? 'ready' : 'running'
}

export const PHASE: Record<PreviewPhase, { label: string; dot: string }> = {
  setup: { label: 'Setting up', dot: 'bg-warning animate-pulse' },
  starting: { label: 'Starting', dot: 'bg-warning animate-pulse' },
  checking: { label: 'Checking', dot: 'bg-warning animate-pulse' },
  ready: { label: 'Ready', dot: 'bg-success' },
  attention: { label: 'Needs a fix', dot: 'bg-destructive' },
  running: { label: 'Running', dot: 'bg-success' },
  failed: { label: 'Failed', dot: 'bg-destructive' },
  stopped: { label: 'Stopped', dot: 'bg-muted-foreground' },
}

/** 12m 05s since it started. */
function useElapsed(since: string | undefined, live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since || !live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since, live])
  if (!since) return undefined
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000))
  const m = Math.floor(seconds / 60)
  return m ? `${m}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

const short = (commit: string) => commit.slice(0, 7)

/** "Preview stopped by a person", "Preview failed: …": reasons that start with "Stopped" read on. */
export function endedText(status: 'failed' | 'stopped', reason?: string) {
  if (status === 'stopped' && reason?.startsWith('Stopped '))
    return `Preview ${reason[0]!.toLowerCase()}${reason.slice(1)}`
  if (status === 'stopped' && reason?.startsWith('Stopped: '))
    return `Preview stopped${reason.slice(7)}`
  return `Preview ${status}${reason ? `: ${reason}` : ''}`
}

export function PreviewPanel({
  threadId,
  preview,
  teammateName,
  computerName,
  mayControl,
  onClose,
  onStart,
  starting,
  waking,
  onAsk,
  expectedCommit,
}: {
  threadId: string
  preview: ThreadPreview
  teammateName: string
  /** Where a preview on a member's own machine runs. */
  computerName: string
  mayControl: boolean
  onClose: () => void
  /** Start it again once it stopped or failed. */
  onStart?: () => void
  /** That start is under way. */
  starting?: boolean
  /** It waits for the workspace computer to start first. */
  waking?: boolean
  /** Put a message to the teammate in the composer (or send it, off the thread). */
  onAsk?: (text: string) => void
  /** The commit it should run (a pull request's head): when it runs another, the panel says so. */
  expectedCommit?: string
}) {
  const [view, setView] = useState<PreviewView>()
  const [error, setError] = useState<string>()
  const [frame, setFrame] = useState(0)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<string>()
  const [showLogs, setShowLogs] = useState(false)
  const [lastLine, setLastLine] = useState<string>()
  const running = preview.status === 'running'
  const phase = previewPhase(preview)

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

  // While it starts, its latest line of output: what the setup or the app is doing.
  const waiting = preview.status === 'starting'
  useEffect(() => {
    if (!waiting) return setLastLine(undefined)
    let live = true
    const read = () =>
      api<{ text: string }>(`/threads/${threadId}/preview/logs`).then(
        ({ text }) => {
          const line = text
            .split('\n')
            .map((l) => l.trim())
            .findLast(Boolean)
          if (live) setLastLine(line)
        },
        () => undefined,
      )
    void read()
    const timer = setInterval(() => void read(), TAIL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [threadId, waiting, preview.previewId])
  const elapsed = useElapsed(preview.startedAt, waiting)

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

  const status = PHASE[phase]
  // What the frame opens: the proxy in front of the app.
  const address = view ? new URL(view.url).host : `localhost:${preview.publicPort ?? preview.port}`
  const otherCommit =
    expectedCommit &&
    preview.commit &&
    !expectedCommit.startsWith(preview.commit) &&
    !preview.commit.startsWith(expectedCommit)
  const failedPages = preview.check?.failed ?? []

  return (
    <SidePanel aria-label="Preview" name={PREVIEW_PANEL} onClose={onClose}>
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <AppWindow aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="flex min-w-0 items-center gap-1.5 text-sm font-semibold whitespace-nowrap">
            <span className={cn('size-2 shrink-0 rounded-full', status.dot)} aria-hidden />
            Preview
            <span className="truncate font-normal text-muted-foreground">· {status.label}</span>
          </strong>
          <span
            className="truncate text-xs text-muted-foreground"
            title={`${preview.cwd ? `${preview.cwd}$ ` : ''}${preview.command} (port ${preview.port})`}
          >
            {preview.repository ?? preview.command}
            {preview.commit && <span className="font-mono"> · {short(preview.commit)}</span>}
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
        <PanelExpandButton />
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
            {otherCommit && (
              <Notice icon={<GitCommitHorizontal aria-hidden className="size-4 shrink-0" />}>
                It runs <span className="font-mono">{short(preview.commit!)}</span>; the pull
                request is at <span className="font-mono">{short(expectedCommit)}</span>.
                {onAsk && (
                  <NoticeAction
                    onClick={() =>
                      onAsk(
                        `Please update your checkout to the latest commit of the pull request (${short(expectedCommit)}) and start its preview again.`,
                      )
                    }
                  >
                    Ask {teammateName} to update it
                  </NoticeAction>
                )}
              </Notice>
            )}
            {phase === 'checking' && (
              <Notice icon={<LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />}>
                Checking its pages as a person would open them…
              </Notice>
            )}
            {phase === 'attention' && (
              <Notice
                tone="destructive"
                icon={<CircleAlert aria-hidden className="size-4 shrink-0" />}
              >
                {failedPages.length
                  ? `The check found problems on ${failedPages.join(', ')}.`
                  : 'The check found problems.'}
                {onAsk && (
                  <NoticeAction
                    onClick={() =>
                      onAsk(
                        `The preview's check found problems${failedPages.length ? ` on ${failedPages.join(', ')}` : ''}. Please fix them and check it again.`,
                      )
                    }
                  >
                    Ask {teammateName} to fix it
                  </NoticeAction>
                )}
              </Notice>
            )}
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
            {preview.status === 'starting' ? (
              <>
                <LoaderCircle aria-hidden className="size-5 animate-spin" />
                <p className="font-medium text-foreground">
                  {preview.reason ?? (phase === 'setup' ? 'Running its setup' : 'Starting the app')}
                  {elapsed && (
                    <span className="font-normal text-muted-foreground"> · {elapsed}</span>
                  )}
                </p>
                {phase === 'setup' && (
                  <p className="max-w-xs">
                    Installing, starting its services and adding sample data. The first start can
                    take a few minutes; later ones are quicker.
                  </p>
                )}
                {lastLine && (
                  <p
                    className="max-w-full truncate rounded bg-muted px-2 py-1 font-mono text-xs"
                    title={lastLine}
                  >
                    {lastLine}
                  </p>
                )}
              </>
            ) : running && !view && !error ? (
              <>
                <LoaderCircle aria-hidden className="size-5 animate-spin" />
                <p>Opening the preview…</p>
              </>
            ) : running ? null : (
              <>
                <p className="max-w-sm font-medium text-foreground">
                  {endedText(preview.status as 'failed' | 'stopped', preview.reason)}
                </p>
                {waking && (
                  <p className="max-w-xs">
                    Starting the cloud computer first. It takes a minute or so; the preview
                    starts once it is up.
                  </p>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  {mayControl && onStart ? (
                    <Button size="sm" disabled={starting} onClick={onStart}>
                      {starting ? (
                        <LoaderCircle aria-hidden className="animate-spin" />
                      ) : (
                        <Play aria-hidden />
                      )}
                      Start again
                    </Button>
                  ) : (
                    !mayControl && <p>Ask {teammateName} to start it again.</p>
                  )}
                  {preview.status === 'failed' && onAsk && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onAsk(
                          `The preview failed${preview.reason ? `: ${preview.reason}` : ''}. Please fix it and start it again.`,
                        )
                      }
                    >
                      Ask {teammateName} to fix it
                    </Button>
                  )}
                </div>
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

/** A line above the frame: what the check found, or that it runs another commit. */
function Notice({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode
  tone?: 'destructive'
  children: React.ReactNode
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs',
        tone === 'destructive'
          ? 'bg-destructive/10 text-destructive-text'
          : 'text-muted-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

function NoticeAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
    >
      {children}
    </button>
  )
}
