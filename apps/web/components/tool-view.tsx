'use client'
// A tool (docs/tools.md) beside the page or a thread: its page in a sandboxed
// frame from the sandbox origin, and the dashboard's side of its bridge
// (lib/tool-host.ts). What the page asks goes to the API with the person's
// session; a write to an App and a message to the thread wait for the person
// to confirm them in a dialog of the dashboard's own, which the page cannot
// draw or click. Accounts the tool asks for are attached from its Accounts
// button, by the people allowed to.
import { toolName, type ToolView } from '@brigade/contracts'
import {
  ChevronDown,
  ExternalLink,
  KeyRound,
  Library,
  Maximize2,
  Minimize2,
  RotateCw,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
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
import { api } from '@/lib/api'
import { answer, bridgeRequest, type ToolConfirm } from '@/lib/tool-host'
import { cn } from '@/lib/utils'

/** The frame's permissions: as a design's, its CSP the same (src/tools.ts on the API). */
const SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type Asking = { what: ToolConfirm; resolve: (yes: boolean) => void }

export function ToolPanel({
  folder,
  threadId,
  onClose,
  libraryLink = true,
}: {
  folder: string
  /** Shown beside this thread: its messages go to it. */
  threadId?: string
  onClose: () => void
  /** A button to the tool in the library (not when already there). */
  libraryLink?: boolean
}) {
  const { me } = useDashboard()
  const [view, setView] = useState<ToolView>()
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(false)
  // What the page asks the person to confirm, one at a time, in order.
  const [asking, setAsking] = useState<Asking[]>([])
  const frame = useRef<HTMLIFrameElement>(null)
  // The view the bridge answers with: the latest, without re-listening on each change.
  const current = useRef<ToolView | undefined>(undefined)
  current.current = view

  const load = useCallback(async () => {
    try {
      const next = await api<ToolView>('/tools/view', { body: { path: folder } })
      setView(next)
      setError(undefined)
      return next
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
  }, [folder])

  // The view again (accounts changed) without reloading the page: its address stays.
  const refresh = useCallback(async () => {
    try {
      const next = await api<ToolView>('/tools/view', { body: { path: folder } })
      setView((was) => (was ? { ...next, url: was.url } : next))
    } catch {
      // The page keeps what it had.
    }
  }, [folder])

  useEffect(() => {
    setView(undefined)
    void load()
  }, [load, reload])

  // Mirrored for closing, when state can no longer be read.
  const waiting = useRef<Asking[]>([])
  waiting.current = asking
  const confirm = useCallback(
    (what: ToolConfirm) =>
      new Promise<boolean>((resolve) => setAsking((list) => [...list, { what, resolve }])),
    [],
  )

  const target = threadId ?? (view?.thread?.mayPrompt ? view.thread.id : undefined)
  const target_ = useRef(target)
  target_.current = target

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only the tool's own frame: its origin is opaque, so by the window it comes from.
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const request = bridgeRequest(e.data)
      const shown = current.current
      if (!request || !shown) return
      const source = e.source as Window
      void answer(
        {
          view: shown,
          threadId: target_.current,
          me: { memberId: me.memberId, name: me.user.name },
          api: (path, body) => api(path, { body }),
          confirm,
        },
        request,
      ).then((reply) => {
        // Still the same page: a reply never goes to one that replaced it.
        if (frame.current?.contentWindow === source) source.postMessage(reply, '*')
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [confirm, me.memberId, me.user.name])

  // Closing the panel answers what was still waiting: no.
  useEffect(
    () => () => {
      for (const a of waiting.current) a.resolve(false)
    },
    [],
  )

  const title = view?.manifest?.title || toolName(folder)
  const slash = folder.lastIndexOf('/')
  const parent = slash >= 0 ? folder.slice(0, slash) : ''
  const needs = view?.manifest?.apps ?? []
  const missing = needs.filter((n) => !view?.accounts.some((a) => a.kind === n.kind)).length
  const changed = view?.accounts.some((a) => a.changed) ?? false
  const first = asking[0]

  function settle(yes: boolean) {
    if (!first) return
    first.resolve(yes)
    setAsking((list) => list.slice(1))
  }

  return (
    <SidePanel
      aria-label={`Tool ${title}`}
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
                tooltip="About this tool"
              >
                <Wrench aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="truncate font-semibold">{title}</span>
                <ChevronDown aria-hidden className="shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuLabel className="flex flex-col gap-1.5 font-normal">
                <span className="text-xs break-words text-muted-foreground">
                  Tool
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
                  <Link href={`/app/library?tool=${encodeURIComponent(folder)}`}>
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
              <DropdownMenuItem onSelect={() => setReload((n) => n + 1)}>
                <RotateCw aria-hidden />
                Reload
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
          {needs.length > 0 && (
            <Button
              type="button"
              variant={missing || changed ? 'secondary' : 'ghost'}
              size="sm"
              tooltip={
                changed
                  ? 'The tool changed: allow its accounts again'
                  : missing
                    ? `${missing} App${missing > 1 ? 's' : ''} to attach`
                    : 'Accounts it uses'
              }
              onClick={() => setAccountsOpen(true)}
            >
              {changed || missing ? (
                <TriangleAlert aria-hidden className="text-warning" />
              ) : (
                <KeyRound aria-hidden />
              )}
              Accounts
            </Button>
          )}
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
            aria-label="Close tool"
          >
            <X aria-hidden />
          </Button>
        </div>
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
      {accountsOpen && view && (
        <ToolAccounts view={view} onChanged={refresh} onClose={() => setAccountsOpen(false)} />
      )}
      {first && <Confirm asking={first} onAnswer={settle} />}
    </SidePanel>
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
              ? `The tool asks to run ${what.operation} with ${what.account}.`
              : `The tool asks to send this message to ${what.thread}, in your name.`}
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
            The tool calls these Apps for whoever opens it and may use the account: a personal
            account works for its owner only. Its code reads what an account returns and could send
            it on, so attach accounts only to tools you trust. Each change to the tool waits for
            someone to allow it again.
          </DialogDescription>
        </DialogHeader>
        {changed && (
          <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm">
            <p>
              The tool changed since its accounts were attached: its calls wait until someone who
              may attach them allows it again.
            </p>
            <Button
              type="button"
              size="sm"
              className="self-start"
              disabled={busy || !view.mayAttach}
              onClick={() => void run('/tools/accounts/allow', { path: view.folder })}
            >
              Allow the changed tool
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
                <div className="flex flex-col gap-0.5">
                  <h3 className="text-sm font-medium">
                    {name}
                    <span className="font-normal text-muted-foreground">
                      {need.access === 'read_write' ? ' · reads and changes' : ' · reads'}
                    </span>
                  </h3>
                  {need.why && <p className="text-xs text-muted-foreground">{need.why}</p>}
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
                          void run('/tools/accounts/detach', {
                            path: view.folder,
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
                        void run('/tools/accounts', {
                          path: view.folder,
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
                    No account of {name} you may attach. Connect one in Apps, or ask the member who
                    connected one.
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
