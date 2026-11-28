'use client'
// A tool (docs/apps.md) beside the page or a thread: its page in a sandboxed
// frame from the sandbox origin, and the dashboard's side of its bridge
// (lib/tool-host.ts). What the page asks goes to the API with the person's
// session; a write to an App and a message to the thread wait for the person
// to confirm them in a dialog of the dashboard's own, which the page cannot
// draw or click. Accounts the tool asks for are attached from its Accounts
// button, by the people allowed to. Ask talks about it with a teammate, as for any
// library file (components/document-discussion.tsx): in the thread that saved it, else
// in a new one, its mention in the reply box.
import { PreviewElement, toolName, type ToolView } from '@brigade/contracts'
import {
  AppWindow,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Library,
  Maximize2,
  MessageSquare,
  Minimize2,
  Laptop,
  SquareArrowOutUpRight,
  SquareMousePointer,
  Trash2,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useDocumentDiscussion } from '@/components/document-discussion'
import {
  libraryDocument,
  MinimizeButton,
  useOptionalDocumentPanel,
} from '@/components/document-panel'
import { ProviderTile, providerKind } from '@/components/provider-logo'
import { SidePanel } from '@/components/side-panel'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ApiError, api } from '@/lib/api'
import { installApp, useInstalledApps } from '@/lib/desktop-apps'
import { appWindowBridge, desktopBridge } from '@/lib/desktop-bridge'
import { useElementPicker, type ElementPicker } from '@/lib/element-pickers'
import { minimizesOnPageChange } from '@/lib/tool-aside'
import { answer, bridgeRequest, connectPort, isBye, type ToolConfirm } from '@/lib/tool-host'
import { cn } from '@/lib/utils'

/** The frame's permissions: as a design's, its CSP the same (src/tools.ts on the API). */
const SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type Asking = { what: ToolConfirm; resolve: (yes: boolean) => void; channel: number }

/**
 * A tool's page and the dashboard's side of its bridge: its view (address and accounts), its
 * frame, and what it asks the person to confirm, one at a time. The panel beside a page or a
 * thread and the window of an installed app (ToolWindow) both hold one.
 */
function useToolHost({
  folder,
  appId,
  threadId,
  setBadge,
}: {
  folder: string
  /** The app it must be (its index.html's id): another one saved at `folder` is refused. */
  appId?: string
  threadId?: string
  /** Where the app has an icon of its own (an installed app's window): its badge. */
  setBadge?: (count: number) => boolean
}) {
  const { me } = useDashboard()
  const [view, setView] = useState<ToolView>()
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  // What the page asks the person to confirm, one at a time, in order.
  const [asking, setAsking] = useState<Asking[]>([])
  const frame = useRef<HTMLIFrameElement>(null)
  // The view the bridge answers with: the latest, without re-listening on each change.
  const current = useRef<ToolView | undefined>(undefined)
  current.current = view

  const [moved, setMoved] = useState(false)
  const body = useMemo(() => ({ path: folder, ...(appId && { id: appId }) }), [folder, appId])
  const load = useCallback(async () => {
    try {
      const next = await api<ToolView>('/apps/view', { body })
      setView(next)
      setError(undefined)
      setMoved(false)
      return next
    } catch (e) {
      setMoved(e instanceof ApiError && e.status === 409)
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
  }, [body])

  // The view again (accounts changed) without reloading the page: its address stays.
  const refresh = useCallback(async () => {
    try {
      const next = await api<ToolView>('/apps/view', { body })
      setView((was) => (was ? { ...next, url: was.url } : next))
    } catch {
      // The page keeps what it had.
    }
  }, [body])

  useEffect(() => {
    setView(undefined)
    void load()
  }, [load, reload])

  // Mirrored for closing, when state can no longer be read.
  const waiting = useRef<Asking[]>([])
  waiting.current = asking
  const confirm = useCallback(
    (what: ToolConfirm, channel: number) =>
      new Promise<boolean>((resolve) => setAsking((list) => [...list, { what, resolve, channel }])),
    [],
  )

  const badge = useRef(setBadge)
  badge.current = setBadge

  const target = threadId ?? (view?.thread?.mayPrompt ? view.thread.id : undefined)
  const target_ = useRef(target)
  target_.current = target

  // The page's channel (lib/tool-host.ts connectPort): one at a time, numbered. Its calls are
  // answered on it only while it is the current one; a page that goes, or a new one, drops what
  // the last one waits for, its questions to the person included.
  const channel = useRef<{ port: MessagePort; id: number } | null>(null)
  const opened = useRef(0)
  const drop = useCallback((id: number) => {
    const gone = waiting.current.filter((a) => a.channel === id)
    for (const a of gone) a.resolve(false)
    if (gone.length) setAsking((list) => list.filter((a) => a.channel !== id))
  }, [])
  const close = useCallback(() => {
    const was = channel.current
    if (!was) return
    channel.current = null
    was.port.close()
    drop(was.id)
  }, [drop])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only the tool's own frame, and only the page that knows its address's key.
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const shown = current.current
      const port = shown && connectPort(e.data, e.ports, shown.bridgeKey)
      if (!port) return
      close()
      const id = ++opened.current
      channel.current = { port, id }
      port.onmessage = (event) => {
        if (channel.current?.id !== id) return
        if (isBye(event.data)) return close()
        const request = bridgeRequest(event.data)
        const view = current.current
        if (!request || !view) return
        void answer(
          {
            view,
            threadId: target_.current,
            me: { memberId: me.memberId, name: me.user.name },
            api: (path, body) => api(path, { body }),
            confirm: (what) => confirm(what, id),
            ...(badge.current && { setBadge: badge.current }),
          },
          request,
        ).then((reply) => {
          // Still the same page: a reply never goes to one that replaced it.
          if (channel.current?.id === id) port.postMessage(reply)
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      close()
    }
  }, [confirm, close, me.memberId, me.user.name])

  // Closing the panel answers what was still waiting: no.
  useEffect(
    () => () => {
      for (const a of waiting.current) a.resolve(false)
    },
    [],
  )

  const first = asking[0]
  function settle(yes: boolean) {
    if (!first) return
    first.resolve(yes)
    setAsking((list) => list.slice(1))
  }
  return {
    view,
    error,
    moved,
    reload,
    again: () => setReload((n) => n + 1),
    refresh,
    frame,
    target,
    first,
    settle,
  }
}

export function ToolPanel({
  folder,
  threadId,
  onClose,
  libraryLink = true,
  inDocuments = false,
  hidden = false,
  onMinimize,
}: {
  folder: string
  /** Shown beside this thread: its messages go to it. */
  threadId?: string
  onClose: () => void
  /** A button to the tool in the library (not when already there). */
  libraryLink?: boolean
  /** Shown by the document panel, which stays open from page to page. */
  inDocuments?: boolean
  /**
   * Kept but not shown (beside a thread while another one shows, components/kept-previews.tsx;
   * a minimized document): its page stays as it was, not loaded again when it shows.
   */
  hidden?: boolean
  /** In the document panel: folds it into its button, as a document does (⌄, ⌘.). */
  onMinimize?: () => void
}) {
  const { me } = useDashboard()
  const { view, error, reload, again, refresh, frame, target, first, settle } = useToolHost({
    folder,
    threadId,
  })
  const [expanded, setExpanded] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const installed = useInstalledApps()
  const install = installed && view ? installed.find((a) => a.appId === view.toolId) : undefined
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)

  const title = view?.manifest?.title || toolName(folder)
  const slash = folder.lastIndexOf('/')
  const parent = slash >= 0 ? folder.slice(0, slash) : ''
  // Its `index.html`, which its mention names. Not beside a thread: that one is already open.
  const toolId = view?.toolId
  const file = useMemo(
    () => (toolId && !threadId ? { id: toolId, path: folder } : null),
    [toolId, threadId, folder],
  )
  const discussion = useDocumentDiscussion(file)
  const documents = useOptionalDocumentPanel()
  // Ask opens a thread as the page: on a wide screen the tool moves to the document panel first,
  // which stays beside it. Below, a panel covers the page: it steps aside for the thread.
  const ask = useCallback(async () => {
    if (!discussion) return
    const wide = window.matchMedia('(min-width: 1280px)').matches
    if (!inDocuments && wide && documents && toolId) {
      documents.open(libraryDocument({ id: toolId, path: folder }))
      onClose()
    }
    await discussion.ask()
  }, [discussion, inDocuments, documents, toolId, folder, onClose])
  // In the document panel below wide screens it covers the page: another page showing (the
  // thread Ask or Select opened, or any other) minimizes it, so that page shows.
  const pathname = usePathname()
  const shownAt = useRef(pathname)
  const aside = useRef({ hidden, onMinimize })
  aside.current = { hidden, onMinimize }
  useEffect(() => {
    const was = shownAt.current
    shownAt.current = pathname
    const { hidden: out, onMinimize: minimize } = aside.current
    if (!minimize) return
    const wide = window.matchMedia('(min-width: 1280px)').matches
    if (minimizesOnPageChange({ inDocuments, hidden: out, wide, shownAt: was, pathname }))
      minimize()
  }, [pathname, inDocuments])
  // Elements picked in the page go to the reply box of the thread beside it, else of the one
  // open last; without one, the button opens the tool's thread first, as Ask does.
  const picker = useElementPicker(threadId)
  const select = useToolSelect(frame, folder, picker)
  // Without a thread open, Select opens the tool's own thread first, when the person may write
  // there: a new thread's composer takes no elements until its first message is sent.
  const opensThread = !picker && !threadId && Boolean(discussion && view?.thread?.mayPrompt)

  return (
    <SidePanel
      aria-label={`App ${title}`}
      hidden={hidden}
      onClose={onClose}
      raiseKey={folder}
      className={cn(
        'outline-none max-xl:top-0 max-xl:h-auto max-xl:rounded-none max-xl:border-t-0',
        expanded &&
          'inset-0 z-50 h-auto rounded-none border-0 xl:inset-0 xl:left-0 xl:z-50 xl:w-auto xl:border-l-0',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-nowrap items-center gap-1 border-b px-2 py-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-0 shrink justify-start gap-1.5 px-1.5"
                tooltip="About this app"
              >
                <AppWindow aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="truncate font-semibold">{title}</span>
                <ChevronDown aria-hidden className="shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuLabel className="flex flex-col gap-1.5 font-normal">
                <span className="text-xs break-words text-muted-foreground">
                  App
                  {view?.teammate && ` · by ${view.teammate.name}`}
                  {parent && <span className="font-mono"> · {parent}</span>}
                </span>
                {view?.manifest?.description && (
                  <span className="text-xs leading-relaxed">{view.manifest.description}</span>
                )}
                {view && (
                  <span className="text-xs text-muted-foreground">
                    {target
                      ? `Its messages go to ${threadId ? 'this thread' : (view.thread?.title ?? 'its thread')}.`
                      : 'It has no thread you can write in.'}
                  </span>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {libraryLink && (
                <DropdownMenuItem asChild>
                  <Link href={`/app/library?app=${encodeURIComponent(folder)}`}>
                    <Library aria-hidden />
                    Open in the library
                  </Link>
                </DropdownMenuItem>
              )}
              {view && (
                <DropdownMenuItem asChild>
                  <a href={view.url} target="_blank" rel="noreferrer noopener">
                    <ExternalLink aria-hidden />
                    Open in a new tab, without Brigade
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={again}>
                <RotateCw aria-hidden />
                Reload
              </DropdownMenuItem>
              {/* Brigade.app: the app in a window of its own, from its own icon. */}
              {installed && view && workspace && (
                <>
                  <DropdownMenuSeparator />
                  {install ? (
                    <>
                      <DropdownMenuItem
                        onSelect={() => void desktopBridge()?.apps?.open(view.toolId)}
                      >
                        <SquareArrowOutUpRight aria-hidden />
                        Open in its own window
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void desktopBridge()?.apps?.uninstall(view.toolId)}
                      >
                        <Trash2 aria-hidden />
                        Uninstall from this computer
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      onSelect={() =>
                        void installApp({
                          appId: view.toolId,
                          folder: view.folder,
                          title,
                          workspace: { id: workspace.id, name: workspace.name },
                          pane: frame.current,
                        }).catch(() => undefined)
                      }
                    >
                      <Laptop aria-hidden />
                      Install as app
                      <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Beta
                      </span>
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
          {view && select.available && (picker || opensThread) && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={select.on}
              aria-label={select.on ? 'Stop selecting' : 'Select an element'}
              tooltip={
                select.on
                  ? 'Stop selecting (Esc)'
                  : picker
                    ? 'Select elements in the app and say what should change on each, then send them together'
                    : `Select elements in the app: opens its thread with ${discussion?.teammate?.name ?? 'its teammate'} first`
              }
              className={cn(select.on && 'bg-primary/12 text-primary hover:text-primary')}
              onClick={() => {
                if (picker) select.set(!select.on)
                else if (opensThread) void ask()
              }}
            >
              <SquareMousePointer aria-hidden />
            </Button>
          )}
          {discussion?.teammate && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              tooltip={`Talk about this app with ${discussion.teammate.name}`}
              aria-label={`Ask ${discussion.teammate.name}`}
              onClick={() => void ask()}
            >
              <MessageSquare aria-hidden />
              <span className="max-sm:hidden">Ask {discussion.teammate.name}</span>
            </Button>
          )}
          {view && <AccountsButton view={view} onClick={() => setAccountsOpen(true)} />}
          {onMinimize && !expanded && <MinimizeButton onMinimize={onMinimize} />}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip={expanded ? 'Back to the panel' : 'Expand'}
            aria-label={expanded ? 'Back to the panel' : 'Expand'}
            className="max-xl:hidden"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close app"
          >
            <X aria-hidden />
          </Button>
        </div>
        {select.on && (
          <p className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <SquareMousePointer aria-hidden className="size-4 shrink-0" />
            Click an element to add it to your edits, then say what should change there. Esc to
            stop.
          </p>
        )}
        <div className="relative min-h-0 flex-1 bg-background">
          {error ? (
            <p className="p-4 text-sm text-muted-foreground">{error}</p>
          ) : view ? (
            <iframe
              key={`${view.url}#${reload}`}
              ref={frame}
              src={view.url}
              title={title}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              className="block size-full border-0"
            />
          ) : null}
        </div>
      </div>
      {/* Dialogs open over the whole page, outside the panel: none while it is hidden. What the
          page asks meanwhile waits for it to show again, and Accounts opens again with it. */}
      {!hidden && accountsOpen && view && (
        <ToolAccounts view={view} onChanged={refresh} onClose={() => setAccountsOpen(false)} />
      )}
      {!hidden && first && <Confirm asking={first} onAnswer={settle} />}
    </SidePanel>
  )
}

/** Accounts, when the app asks for Apps: warned while one is missing or the app changed. */
function AccountsButton({ view, onClick }: { view: ToolView; onClick: () => void }) {
  const needs = view.manifest?.apps ?? []
  if (!needs.length) return null
  const missing = needs.filter((n) => !view.accounts.some((a) => a.kind === n.kind)).length
  const changed = view.accounts.some((a) => a.changed)
  return (
    <Button
      type="button"
      variant={missing || changed ? 'secondary' : 'ghost'}
      size="sm"
      tooltip={
        changed
          ? 'The app changed: allow its accounts again'
          : missing
            ? `${missing} account${missing > 1 ? 's' : ''} to attach`
            : 'Accounts it uses'
      }
      onClick={onClick}
    >
      {changed || missing ? (
        <TriangleAlert aria-hidden className="text-warning" />
      ) : (
        <KeyRound aria-hidden />
      )}
      Accounts
    </Button>
  )
}

/**
 * An installed app's window (Brigade.app, docs/apps.md): the app alone, its Accounts button and
 * the confirmations, as in its panel, without the panel's chrome. Its count shows on its own
 * icon (macOS).
 */
export function ToolWindow({
  folder,
  appId,
  onMoved,
}: {
  folder: string
  appId: string
  /** Another app is at `folder` now (this one moved meanwhile): find it again. */
  onMoved: () => void
}) {
  const setBadge = useCallback((count: number) => {
    const bridge = appWindowBridge()
    if (!bridge) return false
    bridge.apps.setBadge(count)
    return bridge.info.platform === 'darwin'
  }, [])
  const { view, error, moved, reload, refresh, frame, first, settle } = useToolHost({
    folder,
    appId,
    setBadge,
  })
  useEffect(() => {
    if (moved) onMoved()
  }, [moved, onMoved])
  const [accountsOpen, setAccountsOpen] = useState(false)
  const title = view?.manifest?.title || toolName(folder)
  const needsAccounts = (view?.manifest?.apps?.length ?? 0) > 0
  useEffect(() => {
    document.title = title
  }, [title])
  return (
    <main className="flex h-dvh flex-col bg-background" aria-label={`App ${title}`}>
      {view && needsAccounts && (
        <div className="flex items-center justify-end gap-1 border-b px-2 py-1.5">
          <AccountsButton view={view} onClick={() => setAccountsOpen(true)} />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-sm text-muted-foreground">{error}</p>
        ) : view ? (
          <iframe
            key={`${view.url}#${reload}`}
            ref={frame}
            src={view.url}
            title={title}
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
            className="block size-full border-0"
          />
        ) : null}
      </div>
      {accountsOpen && view && (
        <ToolAccounts view={view} onChanged={refresh} onClose={() => setAccountsOpen(false)} />
      )}
      {first && <Confirm asking={first} onAnswer={settle} />}
    </main>
  )
}

/** The dashboard's own question before a tool writes to an App or its thread. */
function Confirm({ asking, onAnswer }: { asking: Asking; onAnswer: (yes: boolean) => void }) {
  const { what } = asking
  const input = what.kind === 'write' ? JSON.stringify(what.input, null, 2) : ''
  return (
    <Dialog open onOpenChange={(o) => !o && onAnswer(false)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {what.kind === 'write'
              ? `Allow this change in ${what.app}?`
              : 'Send this to the thread?'}
          </DialogTitle>
          <DialogDescription>
            {what.kind === 'write'
              ? `The app asks to run ${what.operation} with ${what.account}.`
              : `The app asks to send this message to ${what.thread}, in your name.`}
          </DialogDescription>
        </DialogHeader>
        {what.kind === 'write' ? (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">
            {input}
          </pre>
        ) : (
          <p className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-sm break-words whitespace-pre-wrap">
            {what.text}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onAnswer(false)}>
            Don’t allow
          </Button>
          <Button type="button" onClick={() => onAnswer(true)} autoFocus>
            {what.kind === 'write' ? 'Allow' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The Apps a tool asks for, the accounts attached for each, and attaching one. */
function ToolAccounts({
  view,
  onChanged,
  onClose,
}: {
  view: ToolView
  onChanged: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const needs = view.manifest?.apps ?? []
  const changed = view.accounts.some((a) => a.changed)

  async function run(path: string, body: unknown) {
    setBusy(true)
    setError(undefined)
    try {
      await api(path, { body })
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Accounts</DialogTitle>
          <DialogDescription>
            Attach accounts only to apps you trust: the app’s code sees what they return.
          </DialogDescription>
        </DialogHeader>
        {changed && (
          <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm">
            <p>
              The app changed since its accounts were attached: its calls wait until someone who may
              attach them allows it again.
            </p>
            <Button
              type="button"
              size="sm"
              className="self-start"
              disabled={busy || !view.mayAttach}
              onClick={() =>
                void run('/apps/accounts/allow', { path: view.folder, id: view.toolId })
              }
            >
              Allow the changed app
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-4">
          {needs.map((need) => {
            const attached = view.accounts.filter((a) => a.kind === need.kind)
            const offered = view.attachable.filter((a) => a.kind === need.kind)
            const name = attached[0]?.app ?? offered[0]?.app ?? need.kind
            return (
              <section key={need.kind} className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <ProviderTile kind={providerKind(need.kind)} small />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h3 className="text-sm font-medium">
                      {name}
                      <span className="font-normal text-muted-foreground">
                        {need.access === 'read_write' ? ' · reads and changes' : ' · reads'}
                      </span>
                    </h3>
                    {need.why && <p className="text-xs text-muted-foreground">{need.why}</p>}
                  </div>
                </div>
                {attached.map((a) => (
                  <div
                    key={a.connectionId}
                    className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{a.account}</span>
                      <span className="block text-xs text-muted-foreground">
                        {a.access === 'read_write' ? 'Reads and changes' : 'Reads'}
                        {a.attachedBy && ` · attached by ${a.attachedBy}`}
                        {!a.usable && ' · personal: only its owner’s calls use it'}
                        {a.changed && ' · waiting to be allowed again'}
                      </span>
                    </span>
                    {view.mayAttach && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run('/apps/accounts/detach', {
                            path: view.folder,
                            id: view.toolId,
                            connectionId: a.connectionId,
                          })
                        }
                      >
                        Take off
                      </Button>
                    )}
                  </div>
                ))}
                {offered.map((a) => (
                  <div
                    key={a.connectionId}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{a.account}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run('/apps/accounts', {
                          path: view.folder,
                          id: view.toolId,
                          connectionId: a.connectionId,
                          access: need.access,
                        })
                      }
                    >
                      Attach
                    </Button>
                  </div>
                ))}
                {attached.length === 0 && offered.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No account of {name} you may attach. Connect one in Connected apps, or ask the
                    member who connected one.
                  </p>
                )}
              </section>
            )
          })}
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Picking elements in a tool's page, as in a thread's preview: the sandbox host adds the same
 * script to its pages (contracts' element-select.ts), which says it is there once loaded. The
 * page's origin is opaque (a sandboxed document): messages are told apart by the frame they come
 * from. Where an element is goes as the tool's file in the library (`<folder>/index.html`), never
 * as the page's address, which carries its token.
 */
function useToolSelect(
  frame: RefObject<HTMLIFrameElement | null>,
  folder: string,
  picker: ElementPicker | undefined,
) {
  const [available, setAvailable] = useState(false)
  const [on, setOn] = useState(false)
  const latest = useRef({ on, picker, folder })
  latest.current = { on, picker, folder }

  const send = useCallback(
    (value: boolean) =>
      frame.current?.contentWindow?.postMessage(
        { source: 'brigade', type: 'select', on: value },
        '*',
      ),
    [frame],
  )

  useEffect(() => {
    const listen = (e: MessageEvent) => {
      const data = e.data as {
        source?: string
        type?: string
        id?: unknown
        element?: unknown
        image?: unknown
      } | null
      if (e.source !== frame.current?.contentWindow || data?.source !== 'brigade-preview') return
      const { picker, folder } = latest.current
      if (data.type === 'ready') {
        setAvailable(true)
        // A page that loaded again starts with select mode off.
        if (latest.current.on) send(true)
      } else if (data.type === 'stopped') setOn(false)
      else if (typeof data.id !== 'string' || !picker) return
      else if (data.type === 'selected') {
        const element = PreviewElement.safeParse(data.element)
        if (!element.success) return
        const page = `${folder}/${element.data.page.replace(/^\/t\/[^/]+\//, '') || 'index.html'}`
        picker.handlers.current.element(data.id, { ...element.data, page: page.slice(0, 2000) })
      } else if (data.type === 'captured')
        picker.handlers.current.picture(
          data.id,
          data.image instanceof Blob && data.image.type === 'image/png' ? data.image : undefined,
        )
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [frame, send])

  // No thread to pick for any more: select mode stops.
  const can = Boolean(picker)
  useEffect(() => {
    if (can || !latest.current.on) return
    setOn(false)
    send(false)
  }, [can, send])

  const set = useCallback(
    (value: boolean) => {
      setOn(value)
      send(value)
    },
    [send],
  )
  return { available, on, set }
}
