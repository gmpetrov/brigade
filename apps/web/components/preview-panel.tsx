'use client'
import { DemoMachine } from '@/components/demo-machine'
import { DEMO } from '@/lib/demo/flag'
// The thread's live preview beside it: the app its teammate runs, in a frame,
// as the person's own browser renders it (not a picture of the computer's
// screen). Its state comes from the thread's preview.changed events (or, on a
// pull request, its thread's preview state); its address from the API, which
// hosts the port and hands out its token. While the panel is open it tells the
// API so, which keeps the preview running. Starting, it says what it is doing
// and the app's latest output; running, whether its pages passed their check.
import {
  PreviewElement,
  previewReady,
  type PreviewInfo,
  type PreviewView,
  type SequencedEvent,
  type SourceMatch,
  type ThreadPreviewState,
} from '@brigade/contracts'
import {
  Check,
  CircleAlert,
  CodeXml,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  Play,
  Power,
  RotateCw,
  ScrollText,
  Square,
  SquareMousePointer,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CodeWorkspace } from '@/components/code-workspace'
import { PanelExpandButton, SidePanel, usePanelFull } from '@/components/side-panel'

/** The preview's name among the panels beside a page. */
export const PREVIEW_PANEL = 'preview'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { openCodeTab, setCodePanel, useCodePanel } from '@/lib/code-tabs'
import { previewOrigin, typedPath, withPath } from '@/lib/preview-path'
import { readPreviewPage, rememberPreviewPage } from '@/lib/thread-side'
import { cn } from '@/lib/utils'

export type ThreadPreview = PreviewInfo & { teammateId?: string }

/** How often an open panel says it is still open. Previews stop after 30 minutes unused. */
const TOUCH_MS = 2 * 60_000
/** How long the address's access token (5 minutes) is used again before a fresh one is asked for. */
const TOKEN_REUSE_MS = 3 * 60_000
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

export const PHASE: Record<PreviewPhase, { label: string; dot: string; text: string }> = {
  setup: { label: 'Setting up', dot: 'bg-warning animate-pulse', text: 'text-warning' },
  starting: { label: 'Starting', dot: 'bg-warning animate-pulse', text: 'text-warning' },
  checking: { label: 'Checking', dot: 'bg-warning animate-pulse', text: 'text-warning' },
  ready: { label: 'Ready', dot: 'bg-success', text: 'text-success' },
  attention: { label: 'Needs a fix', dot: 'bg-destructive', text: 'text-destructive-text' },
  running: { label: 'Running', dot: 'bg-success', text: 'text-success' },
  failed: { label: 'Failed', dot: 'bg-destructive', text: 'text-destructive-text' },
  stopped: { label: 'Stopped', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
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

function LivePreviewPanel({
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
  onPick,
  picked = 0,
  code: codeOptions,
  expectedCommit,
  hidden = false,
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
  /**
   * Put an element picked in the page in the composer, then its picture (none when the
   * page could not draw it), by the id the page gave it. Without it, nothing can be picked.
   */
  onPick?: PickHandlers
  /** How many picked elements wait in the composer. */
  picked?: number
  /**
   * The code panel under or beside the preview (components/code-workspace.tsx): the files
   * of the copy it runs, to edit and see at once. Without it, none.
   */
  code?: { mayEdit: boolean; teammateName: (id: string) => string }
  /** The commit it should run (a pull request's head): when it runs another, the panel says so. */
  expectedCommit?: string
  /**
   * Kept while its thread is away (components/kept-previews.tsx): not shown, the page in its
   * frame as it was left, and no longer keeping the preview running.
   */
  hidden?: boolean
}) {
  const [view, setView] = useState<PreviewView>()
  const [error, setError] = useState<string>()
  const [frame, setFrame] = useState(0)
  // A path typed in the bar, opened by loading the frame there when its page cannot be asked.
  const [opened, setOpened] = useState<{ path: string; url: string }>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<string>()
  const [showLogs, setShowLogs] = useState(false)
  const [lastLine, setLastLine] = useState<string>()
  const running = preview.status === 'running'
  const phase = previewPhase(preview)
  // The code beside it: of the copy it runs, the teammate's who started it.
  const coding = codeOptions && preview.teammateId ? codeOptions : undefined
  const codePanel = useCodePanel(threadId)
  const showCode = !!coding && codePanel.open
  const code = useOpenCode(threadId, preview)
  const select = usePreviewSelect(
    view?.url,
    preview.previewId,
    onPick,
    coding ? code.find : undefined,
  )

  // The latest address handed out and when it was asked for: its access token lets people in
  // for 5 minutes. Kept together, so a token is reused only with the time it was asked.
  const issued = useRef<{ url: string; at: number }>(undefined)
  // The address, once per run of the preview.
  useEffect(() => {
    setOpened(undefined)
    issued.current = undefined
    if (!running) return setView(undefined)
    let live = true
    setError(undefined)
    const at = Date.now()
    api<PreviewView>(`/threads/${threadId}/preview`, { body: {} }).then(
      (v) => {
        if (!live) return
        issued.current = { url: v.url, at }
        setView(v)
        // Back on this thread, or on the panel: the page it was left on, loaded again.
        const page = readPreviewPage(threadId, preview.previewId)
        if (page && page !== new URL(v.url).pathname)
          setOpened({ path: page, url: withPath(v.url, page) })
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [threadId, preview.previewId, running])

  // The address again for a new tab or the frame loaded again, with a fresh token once the
  // one it has is old; a copied link always gets one (whoever opens it may take a while).
  const fresh = useCallback(
    async (reuse = true) => {
      const last = issued.current
      if (reuse && last && Date.now() - last.at < TOKEN_REUSE_MS) return last.url
      const at = Date.now()
      const { url } = await api<PreviewView>(`/threads/${threadId}/preview`, { body: {} })
      issued.current = { url, at }
      return url
    },
    [threadId],
  )
  const reload = (path?: string) =>
    void fresh().then(
      (url) => {
        setView((v) => v && { ...v, url })
        const at = path ?? select.page ?? opened?.path
        setOpened(at === undefined ? undefined : { path: at, url: withPath(url, at) })
        setFrame((n) => n + 1)
      },
      (e: Error) => setError(e.message),
    )

  // Where it is, kept for coming back to it.
  const page = select.page ?? opened?.path
  useEffect(() => {
    if (page) rememberPreviewPage(threadId, preview.previewId, page)
  }, [threadId, preview.previewId, page])

  // Still open: keep it running. Kept away from its thread, it may stop as one closed would.
  const live = previewLive(preview)
  useEffect(() => {
    if (!live || hidden) return
    const timer = setInterval(
      () =>
        void api(`/threads/${threadId}/preview`, { body: { touch: true } }).catch(() => undefined),
      TOUCH_MS,
    )
    return () => clearInterval(timer)
  }, [threadId, live, hidden])

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
  const waiting = preview.status === 'starting' && !hidden
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
    <SidePanel
      aria-label="Preview"
      name={PREVIEW_PANEL}
      hidden={hidden}
      onClose={onClose}
      rememberFull={`brigade:preview-full:${threadId}`}
    >
      <div className="flex flex-nowrap items-center gap-1 border-b px-3 py-2.5">
        {/* One bar for the page: where it stands, its address and commit, and its tools. */}
        <div className="@container/bar flex h-8 min-w-0 flex-1 items-center gap-0.5 rounded-lg border bg-card pr-0.5 pl-2.5">
          <Hint label={status.label}>
            <span
              role="img"
              aria-label={`Preview: ${status.label}`}
              className={cn('mr-1 size-2 shrink-0 rounded-full', status.dot)}
            />
          </Hint>
          {view && (
            <BarButton label="Reload" title="Reload the page" onClick={() => reload()}>
              <RotateCw aria-hidden />
            </BarButton>
          )}
          {view ? (
            <PathField
              key={preview.previewId}
              page={select.page ?? opened?.path ?? new URL(view.url).pathname}
              onOpen={(path) => {
                if (!select.navigate(path)) reload(path)
              }}
            />
          ) : (
            <Hint
              label={`${preview.cwd ? `${preview.cwd}$ ` : ''}${preview.command} (port ${preview.port})`}
            >
              <span className={cn('min-w-0 flex-1 truncate px-1 text-xs', status.text)}>
                {status.label}
              </span>
            </Hint>
          )}
          {(preview.repository || preview.commit) && (
            <Hint label={[preview.repository, preview.commit].filter(Boolean).join(' · ')}>
              <span className="hidden shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] whitespace-nowrap text-muted-foreground @[22rem]/bar:inline">
                {[preview.repository?.split('/').pop(), preview.commit && short(preview.commit)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </Hint>
          )}
          {view && (
            <>
              <BarButton
                label={copied ? 'Copied' : 'Copy link'}
                title={
                  copied
                    ? 'Copied'
                    : 'Copy link: whoever opens it in the next 5 minutes can use the preview while it runs'
                }
                onClick={() =>
                  void copyAddress(() => fresh(false)).then(
                    () => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    },
                    (e: Error) => setError(e.message),
                  )
                }
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </BarButton>
              <Button asChild variant="ghost" size="icon-xs" tooltip="Open in a new tab">
                <a
                  href={view.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in a new tab"
                  onClick={(e) => {
                    e.preventDefault()
                    void openAddress(() => fresh()).catch((error: Error) => setError(error.message))
                  }}
                >
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              </Button>
            </>
          )}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          {view && select.available && onPick && (
            <BarButton
              label={select.on === 'mention' ? 'Stop selecting' : 'Select an element'}
              title={
                select.on === 'mention'
                  ? 'Stop selecting (Esc)'
                  : 'Select an element in the page to mention it in your message'
              }
              pressed={select.on === 'mention'}
              onClick={() => select.set(select.on === 'mention' ? false : 'mention')}
            >
              <SquareMousePointer aria-hidden />
            </BarButton>
          )}
          {coding && (
            <BarButton
              label={showCode ? 'Hide the code' : 'Show the code'}
              title={
                showCode
                  ? 'Hide the code'
                  : 'Show the code beside the preview: what you save shows in it'
              }
              pressed={showCode}
              onClick={() => {
                if (showCode && select.on === 'code') select.set(false)
                setCodePanel(threadId, { open: !showCode })
              }}
            >
              <CodeXml aria-hidden />
            </BarButton>
          )}
          <BarButton
            label={showLogs ? 'Hide output' : 'Show output'}
            title={showLogs ? 'Hide output' : "Show the app's output"}
            pressed={showLogs}
            disabled={!live}
            onClick={() => setShowLogs(!showLogs)}
          >
            <ScrollText aria-hidden />
          </BarButton>
        </div>
        <PanelExpandButton />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close preview"
          tooltip="Close"
        >
          <X aria-hidden />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <PreviewSplit
          code={
            showCode && coding ? (
              <CodeWorkspace
                threadId={threadId}
                // Kept away from its thread: its files are no longer watched.
                shown={!hidden}
                teammateId={preview.teammateId!}
                teammateName={coding.teammateName}
                mayEdit={coding.mayEdit}
                cwd={preview.cwd}
                picking={select.on === 'code'}
                onPick={
                  select.available
                    ? () => {
                        code.clear()
                        select.set(select.on === 'code' ? false : 'code')
                      }
                    : undefined
                }
                className="min-h-0 flex-1"
              />
            ) : null
          }
        >
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
                <Notice
                  icon={<LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />}
                >
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
              {select.on === 'mention' && (
                <Notice icon={<SquareMousePointer aria-hidden className="size-4 shrink-0" />}>
                  Click an element to add it to your message
                  {picked > 0 && ` · ${picked} added`}. Esc to stop.
                </Notice>
              )}
              {select.on === 'code' && (
                <Notice icon={<CodeXml aria-hidden className="size-4 shrink-0" />}>
                  Click an element to open its code. Esc to stop.
                </Notice>
              )}
              {code.state && (
                <CodeNotice state={code.state} onOpen={code.open} onClose={code.clear} />
              )}
              {view.local && (
                <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
                  The app runs on {computerName}, so it opens there only, at{' '}
                  <span className="font-mono text-foreground">{address}</span>.
                </p>
              )}
              <iframe
                ref={select.frame}
                key={`${preview.previewId}:${frame}`}
                src={opened?.url ?? view.url}
                title={`Preview of the app ${teammateName} runs`}
                className="min-h-0 w-full flex-1 border-0 bg-white"
                // Its own origin, apart from the dashboard's: scripts and forms run as they would in a tab,
                // and what it opens (a sign-in tab) is a plain tab, without the frame's sandbox.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
                allow="clipboard-read; clipboard-write; fullscreen"
                referrerPolicy="no-referrer"
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
              {preview.status === 'starting' ? (
                <>
                  <LoaderCircle aria-hidden className="size-5 animate-spin" />
                  <p className="font-medium text-foreground">
                    {preview.reason ??
                      (phase === 'setup' ? 'Running its setup' : 'Starting the app')}
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
                      Starting the cloud computer first. It takes a minute or so; the preview starts
                      once it is up.
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
        </PreviewSplit>

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
                tooltip="Refresh"
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

/**
 * Picking elements in the frame. The proxy in front of the app adds a script to its
 * pages (runner/src/preview-select.ts) that says it is there once loaded: only then is
 * the button shown, so a preview from an older runner has none. Select mode is the
 * panel's: it is sent to each page as it loads, and the page sends back what was clicked.
 */
export type PickHandlers = {
  element: (id: string, element: PreviewElement) => void
  picture: (id: string, image?: Blob) => void
}

/** What a click in select mode does: mention the element, or open its code. */
type SelectMode = 'mention' | 'code'

/**
 * The page's path in the bar (`/`, `/app`), not the preview's host, which says
 * nothing to a person. Clicked, it can be edited after its fixed leading `/`:
 * Enter opens the path, Esc puts it back.
 */
function PathField({ page, onOpen }: { page: string; onOpen: (path: string) => void }) {
  const [draft, setDraft] = useState<string>()
  const shown = page.replace(/^\/+/, '')
  return (
    <label className="flex h-6 min-w-0 flex-1 cursor-text items-center rounded-md px-1 font-mono text-xs text-muted-foreground hover:text-foreground focus-within:bg-muted focus-within:text-foreground">
      <span aria-hidden>/</span>
      <input
        type="text"
        aria-label="Page path"
        // Esc here puts the path back, and leaves the panel open.
        data-keyboard
        title="The page's path: edit it and press Enter to open another"
        spellCheck={false}
        autoComplete="off"
        className="h-full min-w-0 flex-1 truncate bg-transparent outline-none"
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown)
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(undefined)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onOpen(typedPath(draft ?? shown))
            setDraft(undefined)
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(undefined)
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

/** A tool in the preview's bar: a small icon button, tinted while it is on. */
function BarButton({
  label,
  title,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  title: string
  /** A toggle: whether it is on. */
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={pressed}
      tooltip={title}
      disabled={disabled}
      className={cn('[&_svg]:size-3.5', pressed && 'bg-primary/12 text-primary hover:text-primary')}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/**
 * Open an address asked for now in a new tab. The tab opens at once, in the click, so popup
 * blockers allow it; its address follows when ready.
 */
async function openAddress(address: () => Promise<string>) {
  const tab = window.open('about:blank', '_blank')
  if (tab) tab.opener = null
  try {
    const url = await address()
    if (tab) tab.location.href = url
    else window.open(url, '_blank', 'noopener')
  } catch (error) {
    tab?.close()
    throw error
  }
}

/**
 * Copy an address asked for now. Safari lets a click write the clipboard only while it
 * handles it: a ClipboardItem takes the address still to come.
 */
async function copyAddress(address: () => Promise<string>) {
  const text = address()
  if (typeof ClipboardItem !== 'undefined')
    try {
      const blob = text.then((url) => new Blob([url], { type: 'text/plain' }))
      return await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
    } catch {
      // A browser whose ClipboardItem takes no promise: the text once it is there.
    }
  return navigator.clipboard.writeText(await text)
}

function usePreviewSelect(
  url: string | undefined,
  previewId: string,
  onPick: PickHandlers | undefined,
  onCode: ((element: PreviewElement) => void) | undefined,
) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [available, setAvailable] = useState(false)
  const [on, setOn] = useState<SelectMode | false>(false)
  // The path the page is at, as it says: for the address bar.
  const [page, setPage] = useState<string>()
  const latest = useRef({ on, onPick, onCode })
  latest.current = { on, onPick, onCode }
  const origin = url ? new URL(url).origin : undefined
  // The page's own origin, as its ready said: the address's, or a grant of it in Safari's frame.
  const pageOrigin = useRef<string>(undefined)

  useEffect(() => {
    setAvailable(false)
    setOn(false)
    setPage(undefined)
    pageOrigin.current = undefined
  }, [previewId, origin])

  const send = useCallback(
    (value: boolean) =>
      origin &&
      frame.current?.contentWindow?.postMessage(
        { source: 'brigade', type: 'select', on: value },
        pageOrigin.current ?? origin,
      ),
    [origin],
  )

  const picking = !!onPick || !!onCode
  useEffect(() => {
    if (!origin) return
    const listen = (e: MessageEvent) => {
      const data = e.data as {
        source?: string
        type?: string
        id?: unknown
        element?: unknown
        image?: unknown
        page?: unknown
      } | null
      if (
        !previewOrigin(e.origin, origin) ||
        e.source !== frame.current?.contentWindow ||
        data?.source !== 'brigade-preview'
      )
        return
      if (data.type === 'ready') {
        pageOrigin.current = e.origin
        setAvailable(true)
        // A page it navigated to starts with select mode off; either way it then says where it is.
        if (latest.current.on) send(true)
        else
          frame.current?.contentWindow?.postMessage({ source: 'brigade', type: 'hello' }, e.origin)
      } else if (data.type === 'location') {
        if (typeof data.page === 'string') setPage(data.page)
      } else if (data.type === 'stopped') setOn(false)
      else if (typeof data.id !== 'string') return
      else if (data.type === 'selected') {
        const element = PreviewElement.safeParse(data.element)
        if (!element.success) return
        if (latest.current.on === 'code') {
          // One element's code at a time: its file opens over the preview.
          setOn(false)
          send(false)
          latest.current.onCode?.(element.data)
        } else latest.current.onPick?.element(data.id, element.data)
      } else if (data.type === 'captured' && latest.current.onPick)
        latest.current.onPick.picture(
          data.id,
          data.image instanceof Blob && data.image.type === 'image/png' ? data.image : undefined,
        )
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [origin, send])

  const set = useCallback(
    (value: SelectMode | false) => {
      setOn(value)
      send(!!value)
    },
    [send],
  )
  /** Open a path in the page, as a link in it would; false when the page cannot be asked. */
  const navigate = useCallback(
    (path: string) => {
      const target = frame.current?.contentWindow
      // Only a page that said where it is opens a path: older scripts say ready, not that.
      if (page === undefined || !origin || !target) return false
      target.postMessage(
        { source: 'brigade', type: 'navigate', page: path },
        pageOrigin.current ?? origin,
      )
      return true
    },
    [page, origin],
  )
  return {
    frame,
    /** The page can pick: to mention (onPick) or to open code (onCode). */
    available: available && picking,
    on: picking ? on : false,
    set,
    page,
    navigate,
  }
}

type CodeState =
  | { kind: 'searching' }
  | { kind: 'none'; text?: string }
  | { kind: 'many'; matches: SourceMatch[] }
  | { kind: 'error'; message: string }

/**
 * The code of an element picked in the preview: its text searched in the preview's
 * folder, by the runner. One file holding it opens at once; several, the person picks.
 */
function useOpenCode(threadId: string, preview: ThreadPreview) {
  const [state, setState] = useState<CodeState>()
  const latest = useRef({ preview })
  latest.current = { preview }
  const asked = useRef(0)

  // In a tab of the code beside the preview, which shows.
  const open = useCallback(
    (match: SourceMatch) => {
      setState(undefined)
      const { teammateId } = latest.current.preview
      if (teammateId) openCodeTab(threadId, { teammateId, path: match.path, line: match.line })
    },
    [threadId],
  )

  const find = useCallback(
    (element: PreviewElement) => {
      const { preview } = latest.current
      const text = element.text?.replace(/…$/, '').trim()
      if (!text || !preview.teammateId) return setState({ kind: 'none' })
      const ask = ++asked.current
      setState({ kind: 'searching' })
      api<{ matches: SourceMatch[] }>(`/threads/${threadId}/source`, {
        body: {
          teammateId: preview.teammateId,
          cwd: preview.cwd,
          text: text.slice(0, 500),
          ...(element.components?.length ? { components: element.components } : {}),
        },
      }).then(
        ({ matches }) => {
          if (ask !== asked.current) return
          const files = new Set(matches.map((m) => m.path))
          if (files.size === 1) open(matches[0]!)
          else if (matches.length) setState({ kind: 'many', matches })
          else setState({ kind: 'none', text })
        },
        (e: Error) => ask === asked.current && setState({ kind: 'error', message: e.message }),
      )
    },
    [threadId, open],
  )

  const clear = useCallback(() => {
    asked.current++
    setState(undefined)
  }, [])

  return { state, find, open, clear }
}

/** What looking for an element's code found, above the frame. */
function CodeNotice({
  state,
  onOpen,
  onClose,
}: {
  state: CodeState
  onOpen: (match: SourceMatch) => void
  onClose: () => void
}) {
  const dismiss = (
    <button
      type="button"
      aria-label="Dismiss"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={onClose}
    >
      <X aria-hidden className="size-3.5" />
    </button>
  )
  if (state.kind === 'searching')
    return (
      <Notice icon={<LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />}>
        Looking for its code…
      </Notice>
    )
  if (state.kind === 'error')
    return (
      <Notice
        tone="destructive"
        icon={<CircleAlert aria-hidden className="size-4 shrink-0" />}
        end={dismiss}
      >
        {state.message}
      </Notice>
    )
  if (state.kind === 'none')
    return (
      <Notice icon={<CodeXml aria-hidden className="size-4 shrink-0" />} end={dismiss}>
        {state.text
          ? 'Its text is not written as such in the code: it may come from data or be put together.'
          : 'It has no text to look for in the code. Pick an element with text.'}
      </Notice>
    )
  return (
    <div role="status" className="border-b px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <CodeXml aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          Its text is in {new Set(state.matches.map((m) => m.path)).size} files. Which one?
        </span>
        {dismiss}
      </div>
      <ul className="mt-1.5 flex max-h-40 flex-col overflow-y-auto">
        {state.matches.map((m) => (
          <li key={`${m.path}:${m.line}`}>
            <button
              type="button"
              className="flex w-full min-w-0 items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
              onClick={() => onOpen(m)}
            >
              <span className="shrink-0 font-mono text-foreground">
                {m.path.split('/').pop()}:{m.line}
              </span>
              <Hint label={m.path}>
                <span className="truncate font-mono text-muted-foreground">{m.preview}</span>
              </Hint>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Matches a media query, as the window changes. */
function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (change) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', change)
      return () => list.removeEventListener('change', change)
    },
    () => window.matchMedia(query).matches,
    () => true,
  )
}

/** The preview's share of the split, by layout, remembered in this browser. */
const SPLIT_KEY = 'brigade:preview-split'
const readSplit = (): { rows: number; cols: number } => {
  try {
    const saved = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null') as {
      rows?: number
      cols?: number
    } | null
    return { rows: saved?.rows ?? 0.5, cols: saved?.cols ?? 0.5 }
  } catch {
    return { rows: 0.5, cols: 0.5 }
  }
}
const clampSplit = (share: number) => Math.min(0.85, Math.max(0.15, share))

/**
 * The preview with the code beside it. In the panel, which is narrow and tall, the code
 * goes under the preview; laid over the whole window, the code goes left and the
 * preview right, as in an editor; on a phone, one at a time. A bar between them sets
 * their shares. The frame stays the same element whatever the layout: the page in it
 * never reloads when the code shows or hides.
 */
function PreviewSplit({ children, code }: { children: React.ReactNode; code: React.ReactNode }) {
  const full = usePanelFull()
  const wide = useMediaQuery('(min-width: 1280px)')
  const side = full && wide
  const [split, setSplit] = useState(readSplit)
  const [dragging, setDragging] = useState(false)
  const [phoneShows, setPhoneShows] = useState<'preview' | 'code'>('code')
  const box = useRef<HTMLDivElement>(null)
  const share = side ? split.cols : split.rows
  const setShare = (next: number) => {
    const value = clampSplit(next)
    setSplit((s) => {
      const updated = side ? { ...s, cols: value } : { ...s, rows: value }
      try {
        localStorage.setItem(SPLIT_KEY, JSON.stringify(updated))
      } catch {
        // No storage: for this page only.
      }
      return updated
    })
  }
  // The code just opened on a phone: it shows.
  const hasCode = !!code
  useEffect(() => {
    if (hasCode) setPhoneShows('code')
  }, [hasCode])

  const phone = !wide
  const previewHidden = hasCode && phone && phoneShows === 'code'
  const move = (e: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect) return
    // Side by side the code is on the left: the preview has what is right of the bar.
    setShare(side ? 1 - (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height)
  }

  return (
    <div ref={box} className={cn('relative flex min-h-0 flex-1', side ? 'flex-row' : 'flex-col')}>
      {hasCode && phone && (
        <div key="switch" className="flex shrink-0 gap-1 border-b p-1.5" role="tablist">
          {(['preview', 'code'] as const).map((which) => (
            <button
              key={which}
              type="button"
              role="tab"
              aria-selected={phoneShows === which}
              className={cn(
                'flex-1 rounded-md py-1 text-xs font-medium',
                phoneShows === which ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
              onClick={() => setPhoneShows(which)}
            >
              {which === 'preview' ? 'Preview' : 'Code'}
            </button>
          ))}
        </div>
      )}
      <div
        key="frame"
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          // The frame would take the pointer from the bar while it moves.
          dragging && 'pointer-events-none select-none',
          previewHidden && 'hidden',
        )}
        style={{ order: side ? 3 : 1, flex: hasCode && !phone ? `${share} 1 0px` : '1 1 0px' }}
      >
        {children}
      </div>
      {hasCode && !phone && (
        <div
          key="bar"
          role="separator"
          aria-orientation={side ? 'vertical' : 'horizontal'}
          aria-label="Resize the preview and the code"
          aria-valuenow={Math.round(share * 100)}
          aria-valuemin={15}
          aria-valuemax={85}
          tabIndex={0}
          className={cn(
            'relative z-10 shrink-0 bg-border outline-none hover:bg-primary/50 focus-visible:bg-primary',
            dragging && 'bg-primary',
            side ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
            // A wider grip than the line it draws.
            side
              ? 'before:absolute before:inset-y-0 before:-right-1.5 before:-left-1.5'
              : 'before:absolute before:inset-x-0 before:-top-1.5 before:-bottom-1.5',
          )}
          style={{ order: 2 }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            setDragging(true)
          }}
          onPointerMove={(e) => dragging && move(e)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onDoubleClick={() => setShare(0.5)}
          onKeyDown={(e) => {
            const step = { ArrowUp: -0.05, ArrowLeft: 0.05, ArrowDown: 0.05, ArrowRight: -0.05 }[
              e.key
            ]
            if (step === undefined) return
            e.preventDefault()
            setShare(share + step)
          }}
        />
      )}
      {hasCode && (
        <div
          key="code"
          className={cn(
            'flex min-h-0 min-w-0 flex-col',
            phone && phoneShows !== 'code' && 'hidden',
          )}
          style={{ order: side ? 1 : 3, flex: phone ? '1 1 0px' : `${1 - share} 1 0px` }}
        >
          {code}
        </div>
      )}
    </div>
  )
}

/** A line above the frame: what the check found, or that it runs another commit. */
function Notice({
  icon,
  tone,
  end,
  children,
}: {
  icon: React.ReactNode
  tone?: 'destructive'
  /** After the text, at the end of the line: a button to dismiss it. */
  end?: React.ReactNode
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
      {end}
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

/** In the demo, what it would show: there is no computer behind it (components/demo-machine.tsx). */
export function PreviewPanel(props: Parameters<typeof LivePreviewPanel>[0]) {
  if (DEMO && props.hidden) return null
  return DEMO ? (
    <DemoMachine what="preview" onClose={props.onClose} />
  ) : (
    <LivePreviewPanel {...props} />
  )
}
