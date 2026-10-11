'use client'
// A design a teammate made: its page from the sandbox origin (another site
// than the dashboard, no cookies, a sandboxed document), at a viewport's
// width and scaled down to fit. Beside a thread or the library, or expanded
// over the page. Around it: comments on an element, sent to the thread that
// made it; knobs to try values and save them; export; hand-off to a thread
// that builds it. The page and the viewer talk through the bridge the sandbox
// host adds to it (apps/api/src/design-bridge.ts), by postMessage only.
import {
  designName,
  formatMention,
  type DesignKnob,
  type DesignView as DesignViewInfo,
  type DesignViewport,
} from '@brigade/contracts'
import {
  Download,
  ExternalLink,
  Hammer,
  Library,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Monitor,
  Palette,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NewThread, useLastTeammate, useThreadDraft } from '@/components/new-thread'
import { SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

const WIDTH: Record<DesignViewport, number> = { desktop: 1280, tablet: 820, mobile: 390 }
const ICON = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } satisfies Record<
  DesignViewport,
  unknown
>
const ALL: DesignViewport[] = ['desktop', 'tablet', 'mobile']

/** What the bridge in the page sends. */
type Picked = { dataId: string | null; selector: string; text: string; html: string }
type Captured = { data: string; width: number; height: number; notes: string }
type FromPage =
  | { type: 'ready'; slides: number }
  | ({ type: 'picked' } & Picked)
  | { type: 'cancel' }
  | { type: 'captured'; id: string; images?: Captured[]; error?: string }

/** A new thread to start, with its first message written. */
type Starting = { title: string; description: string; text: string; teammateId?: string }

const mention = (folder: string) => formatMention({ kind: 'design', id: folder, label: folder })

function commentText(input: {
  folder: string
  viewport: DesignViewport
  picked: Picked | null
  body: string
}) {
  const where = `at ${input.viewport} (${WIDTH[input.viewport]}px)`
  const on = input.picked
    ? input.picked.dataId
      ? `, on \`${input.picked.dataId}\``
      : `, on the element \`${input.picked.selector}\``
    : ''
  const snippet = input.picked ? `\n\n> ${input.picked.html.replace(/`/g, "'")}` : ''
  return `Comment on the design ${mention(input.folder)} ${where}${on}:${snippet}\n\n${input.body.trim()}`
}

const handoffText = (folder: string) =>
  `Build the design ${mention(folder)} in the product. Match it at each of its viewports, with the ` +
  "product's own components and conventions and the values in its knobs.json, then open a pull request."

function download(href: string, name: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.click()
}

/** The design's page and everything around it. `version` changes when its files do, to load it again. */
function DesignFrame({
  folder,
  version,
  threadId,
  onInfo,
  onStart,
}: {
  /** The design's library folder ("acme/pricing.design"). */
  folder: string
  version?: string
  /** Shown beside this thread: comments go to it. */
  threadId?: string
  onInfo?: (info: DesignViewInfo) => void
  onStart: (start: Starting) => void
}) {
  const [view, setView] = useState<DesignViewInfo>()
  const [error, setError] = useState<string>()
  const [viewport, setViewport] = useState<DesignViewport>()
  const [reloads, setReloads] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ready, setReady] = useState<{ slides: number }>()
  const [mode, setMode] = useState<'comment' | 'knobs' | null>(null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ text: string; href?: string; error?: boolean }>()
  const [busy, setBusy] = useState<string>()
  const captures = useRef(new Map<string, (m: Extract<FromPage, { type: 'captured' }>) => void>())

  useEffect(() => {
    let live = true
    setError(undefined)
    api<DesignViewInfo>('/designs/view', { body: { path: folder } }).then(
      (v) => {
        if (!live) return
        setView(v)
        setValues(Object.fromEntries(v.knobs.map((k) => [k.var, k.value])))
        onInfo?.(v)
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per design and version
  }, [folder, version])

  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry!.contentRect.width, height: entry!.contentRect.height }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const post = useCallback((message: Record<string, unknown>) => {
    // The page's origin is opaque: '*' is the only target; what is sent is not secret.
    frame.current?.contentWindow?.postMessage(message, '*')
  }, [])

  // The page's messages. Its own script could send these too: they only ever fill the viewer.
  const state = useRef({ picking, values })
  state.current = { picking, values }
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as FromPage & { source?: string }
      if (m?.source !== 'brigade-design') return
      if (m.type === 'ready') {
        setReady({ slides: Number(m.slides) || 0 })
        // A reloaded page gets the viewer's state again.
        post({ type: 'brigade:vars', vars: state.current.values })
        post({ type: 'brigade:pick', on: state.current.picking })
      } else if (m.type === 'picked') {
        setPicked({
          dataId: typeof m.dataId === 'string' ? m.dataId.slice(0, 100) : null,
          selector: String(m.selector).slice(0, 300),
          text: String(m.text).slice(0, 200),
          html: String(m.html).slice(0, 500),
        })
        setPicking(false)
        post({ type: 'brigade:pick', on: false })
      } else if (m.type === 'cancel') {
        setPicking(false)
        post({ type: 'brigade:pick', on: false })
      } else if (m.type === 'captured') {
        captures.current.get(String(m.id))?.(m)
        captures.current.delete(String(m.id))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [post])

  const offered = view?.manifest?.viewports?.length ? view.manifest.viewports : ALL
  const shown = viewport && offered.includes(viewport) ? viewport : offered[0]!
  const width = WIDTH[shown]
  const scale = size.width ? Math.min(1, size.width / width) : 1
  const name = designName(folder)

  function pick(on: boolean) {
    setPicking(on)
    post({ type: 'brigade:pick', on })
  }

  function capture(slides: boolean) {
    const id = Math.random().toString(36).slice(2)
    return new Promise<Captured[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        captures.current.delete(id)
        reject(new Error('The page did not answer. Reload it and try again.'))
      }, 60_000)
      captures.current.set(id, (m) => {
        clearTimeout(timer)
        if (m.error || !m.images) reject(new Error(m.error ?? 'Nothing was captured'))
        else resolve(m.images)
      })
      post({ type: 'brigade:capture', id, slides })
    })
  }

  async function exporting(label: string, work: () => Promise<void>) {
    setBusy(label)
    setNotice(undefined)
    try {
      await work()
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true })
    }
    setBusy(undefined)
  }

  const exportPng = () =>
    exporting('Capturing…', async () => {
      const [image] = await capture(false)
      if (image) download(image.data, `${name}-${shown}.png`)
    })

  const exportPptx = () =>
    exporting('Making the deck…', async () => {
      const images = await capture(true)
      const { default: PptxGenJS } = await import('pptxgenjs')
      const deck = new PptxGenJS()
      const first = images[0]!
      // The slides' own shape, 10 inches wide.
      deck.defineLayout({ name: 'DESIGN', width: 10, height: (10 * first.height) / first.width })
      deck.layout = 'DESIGN'
      deck.title = view?.manifest?.title ?? name
      for (const image of images) {
        const slide = deck.addSlide()
        slide.addImage({ data: image.data, x: 0, y: 0, w: '100%', h: '100%' })
        if (image.notes) slide.addNotes(image.notes)
      }
      await deck.writeFile({ fileName: `${name}.pptx` })
    })

  // Where a comment goes: this thread, else the one that made the design if this member may write to it.
  const commentThread = threadId ?? (view?.thread?.mayPrompt ? view.thread.id : undefined)

  async function sendComment(body: string) {
    const text = commentText({ folder, viewport: shown, picked, body })
    if (!commentThread) {
      onStart({
        title: 'Send the comment in a new thread',
        description: view?.thread
          ? `The thread that made this design runs on another member's subscription. Start one to ${view.teammate?.name ?? 'a teammate'}.`
          : 'No thread made this design that you can write to. Start one.',
        text,
        ...(view?.teammate ? { teammateId: view.teammate.id } : {}),
      })
      return true
    }
    try {
      await api(`/threads/${commentThread}/messages`, { body: { text } })
      setPicked(null)
      setNotice(
        commentThread === threadId
          ? { text: 'Sent to this thread.' }
          : {
              text: `Sent to “${view?.thread?.title ?? 'the thread'}”.`,
              href: `/app/threads/${commentThread}`,
            },
      )
      return true
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true })
      return false
    }
  }

  function setKnob(knob: DesignKnob, value: string) {
    const next = { ...values, [knob.var]: value }
    setValues(next)
    post({ type: 'brigade:vars', vars: { [knob.var]: value } })
  }

  const changed = view ? view.knobs.filter((k) => values[k.var] !== k.value) : []

  async function saveKnobs() {
    if (!view) return
    setBusy('Saving…')
    setNotice(undefined)
    try {
      const { knobs } = await api<{ knobs: DesignKnob[] }>('/designs/knobs', {
        method: 'PUT',
        body: {
          path: folder,
          values: Object.fromEntries(changed.map((k) => [k.var, values[k.var]])),
        },
      })
      setView({ ...view, knobs })
      setNotice({ text: 'Saved to knobs.json.' })
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true })
    }
    setBusy(undefined)
  }

  function resetKnobs() {
    if (!view) return
    const saved = Object.fromEntries(view.knobs.map((k) => [k.var, k.value]))
    setValues(saved)
    post({ type: 'brigade:vars', vars: saved })
  }

  const slides = (ready?.slides ?? 0) > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <Tabs value={shown} onValueChange={(v) => setViewport(v as DesignViewport)}>
          <TabsList aria-label="Viewport">
            {offered.map((v) => {
              const Icon = ICON[v]
              return (
                <TabsTrigger
                  key={v}
                  value={v}
                  title={`${v[0]!.toUpperCase()}${v.slice(1)}, ${WIDTH[v]}px`}
                >
                  <Icon aria-hidden />
                  <span className="sr-only">{v}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground tabular-nums">
          {width}px{scale < 1 && ` · ${Math.round(scale * 100)}%`}
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant={mode === 'comment' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={mode === 'comment'}
          disabled={!view}
          onClick={() => {
            const on = mode !== 'comment'
            setMode(on ? 'comment' : null)
            pick(on && !picked)
          }}
        >
          <MessageSquarePlus aria-hidden />
          Comment
        </Button>
        {view && view.knobs.length > 0 && (
          <Button
            type="button"
            variant={mode === 'knobs' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={mode === 'knobs'}
            onClick={() => {
              setMode(mode === 'knobs' ? null : 'knobs')
              pick(false)
            }}
          >
            <SlidersHorizontal aria-hidden />
            Knobs
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Export"
              aria-label="Export"
              disabled={!view}
            >
              <Download aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <a href={`${API_URL}/api/designs/zip?path=${encodeURIComponent(folder)}`}>
                HTML (.zip)
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => post({ type: 'brigade:print' })}>
              PDF (print)
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => void exportPng()}>
              Image (.png), {shown}
            </DropdownMenuItem>
            {slides && (
              <DropdownMenuItem onSelect={() => void exportPptx()}>
                PowerPoint (.pptx)
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Hand off: start a thread that builds it"
          aria-label="Hand off"
          disabled={!view}
          onClick={() =>
            onStart({
              title: 'Hand off the design',
              description:
                'Start a thread that builds it. Mention the repository it goes in (type @).',
              text: handoffText(folder),
            })
          }
        >
          <Hammer aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Reload"
          aria-label="Reload"
          onClick={() => (setReady(undefined), setReloads((n) => n + 1))}
        >
          <RotateCw aria-hidden />
        </Button>
        {view && (
          <Button asChild variant="ghost" size="icon-sm" title="Open in a new tab">
            <a
              href={view.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open in a new tab"
            >
              <ExternalLink aria-hidden />
            </a>
          </Button>
        )}
      </div>

      {(busy || notice) && (
        <p
          role="status"
          className={cn(
            'border-b px-3 py-1.5 text-xs',
            notice?.error ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          {busy ?? notice?.text}
          {!busy && notice?.href && (
            <>
              {' '}
              <Link href={notice.href} className="font-medium text-primary hover:underline">
                Open it
              </Link>
            </>
          )}
        </p>
      )}

      {mode === 'knobs' && view && (
        <Knobs
          knobs={view.knobs}
          values={values}
          onChange={setKnob}
          changed={changed.length}
          busy={Boolean(busy)}
          onSave={() => void saveKnobs()}
          onReset={resetKnobs}
        />
      )}

      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden bg-muted/40">
        {error ? (
          <p className="p-4 text-sm text-destructive-text">{error}</p>
        ) : !view ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          size.width > 0 && (
            <iframe
              ref={frame}
              key={`${view.url}#${reloads}`}
              title={view.manifest?.title ?? name}
              src={view.url}
              // Its own site already; the sandbox keeps it from the top window and from forms that navigate it.
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
              referrerPolicy="no-referrer"
              className={cn(
                'absolute top-0 border-0 bg-white',
                picking && 'outline-2 outline-primary outline-dashed',
              )}
              style={{
                width,
                height: size.height / scale,
                left: Math.max(0, (size.width - width * scale) / 2),
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            />
          )
        )}
      </div>

      {mode === 'comment' && view && (
        <CommentBox
          picked={picked}
          picking={picking}
          target={
            commentThread === threadId && threadId
              ? 'this thread'
              : commentThread
                ? `“${view.thread?.title}”`
                : 'a new thread'
          }
          onPick={() => pick(!picking)}
          onClear={() => setPicked(null)}
          onSend={sendComment}
        />
      )}
    </div>
  )
}

function CommentBox({
  picked,
  picking,
  target,
  onPick,
  onClear,
  onSend,
}: {
  picked: Picked | null
  picking: boolean
  target: string
  onPick: () => void
  onClear: () => void
  onSend: (body: string) => Promise<boolean>
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  async function send() {
    if (!body.trim() || sending) return
    setSending(true)
    if (await onSend(body)) setBody('')
    setSending(false)
  }

  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {picked ? (
          <>
            <span className="text-muted-foreground">On</span>
            <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5" title={picked.html}>
              {picked.dataId ?? picked.selector}
            </code>
            {picked.text && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">“{picked.text}”</span>
            )}
            <button
              type="button"
              className="shrink-0 font-medium text-primary hover:underline"
              onClick={onClear}
            >
              The whole design
            </button>
          </>
        ) : (
          <span className="flex-1 text-muted-foreground">
            {picking ? 'Click an element in the design. Escape to stop.' : 'On the whole design.'}
          </span>
        )}
        <button
          type="button"
          className="shrink-0 font-medium text-primary hover:underline"
          onClick={onPick}
        >
          {picking ? 'Stop picking' : 'Pick an element'}
        </button>
      </div>
      <Textarea
        aria-label="Comment"
        value={body}
        rows={2}
        placeholder="What should change?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          }
        }}
        className="bg-card text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">To {target}</span>
        <Button size="sm" disabled={!body.trim() || sending} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  )
}

/** A range knob's number and unit, from its value ("12px"). */
const numberOf = (value: string) => Number.parseFloat(value)

function Knobs({
  knobs,
  values,
  onChange,
  changed,
  busy,
  onSave,
  onReset,
}: {
  knobs: DesignKnob[]
  values: Record<string, string>
  onChange: (knob: DesignKnob, value: string) => void
  changed: number
  busy: boolean
  onSave: () => void
  onReset: () => void
}) {
  return (
    <div className="flex max-h-[40%] flex-col gap-3 overflow-y-auto border-b px-3 py-3">
      {knobs.map((k) => {
        const value = values[k.var] ?? k.value
        const id = `knob-${k.var}`
        const label = k.label ?? k.var
        return (
          <div key={k.var} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
            <label htmlFor={id} className="truncate text-xs font-medium" title={k.var}>
              {label}
            </label>
            {k.type === 'color' ? (
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
                  onChange={(e) => onChange(k, e.target.value)}
                  className="h-7 w-10 cursor-pointer rounded border bg-transparent"
                />
                <Input
                  aria-label={`${label}, as CSS`}
                  value={value}
                  onChange={(e) => onChange(k, e.target.value)}
                  className="h-7 font-mono text-xs"
                />
              </div>
            ) : k.type === 'range' ? (
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  type="range"
                  min={k.min ?? 0}
                  max={k.max ?? 100}
                  step={k.step ?? 1}
                  value={Number.isFinite(numberOf(value)) ? numberOf(value) : (k.min ?? 0)}
                  onChange={(e) => onChange(k, `${e.target.value}${k.unit ?? ''}`)}
                  className="min-w-0 flex-1 accent-primary"
                />
                <span className="w-14 text-right font-mono text-xs tabular-nums">{value}</span>
              </div>
            ) : k.type === 'select' && k.options?.length ? (
              <select
                id={id}
                value={value}
                onChange={(e) => onChange(k, e.target.value)}
                className="h-7 rounded-md border bg-transparent px-2 text-xs"
              >
                {!k.options.some((o) => o.value === value) && (
                  <option value={value}>{value}</option>
                )}
                {k.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={id}
                value={value}
                onChange={(e) => onChange(k, e.target.value)}
                className="h-7 font-mono text-xs"
              />
            )}
          </div>
        )
      })}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {changed ? `${changed} changed, not saved` : 'Saved values'}
        </span>
        <Button size="sm" variant="outline" disabled={!changed || busy} onClick={onReset}>
          Reset
        </Button>
        <Button size="sm" disabled={!changed || busy} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  )
}

/** A thread to start from the viewer: a comment nobody can receive yet, or a hand-off. */
function StartThreadDialog({ start, onClose }: { start: Starting; onClose: () => void }) {
  const { teammates } = useDashboard()
  const draft = useThreadDraft()
  const [lastId, setLastId] = useLastTeammate()
  const [chosen, setChosen] = useState(start.teammateId)
  const teammate =
    teammates.find((t) => t.id === chosen) ?? teammates.find((t) => t.id === lastId) ?? teammates[0]
  const { setText } = draft
  useEffect(() => setText(start.text), [start.text, setText])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{start.title}</DialogTitle>
          <DialogDescription>{start.description}</DialogDescription>
        </DialogHeader>
        {teammate ? (
          <NewThread
            teammate={teammate}
            picker={{
              teammates,
              onChange: (id) => {
                setChosen(id)
                setLastId(id)
              },
            }}
            draft={draft}
            rows={6}
            autoFocus
          />
        ) : (
          <p className="text-sm text-muted-foreground">Add a teammate first.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A design beside the page, or expanded over it. */
export function DesignPanel({
  folder,
  version,
  threadId,
  onClose,
  libraryLink = true,
}: {
  folder: string
  version?: string
  /** Shown beside this thread: comments go to it. */
  threadId?: string
  onClose: () => void
  /** A button to the design in the library (not when already there). */
  libraryLink?: boolean
}) {
  const [info, setInfo] = useState<DesignViewInfo>()
  const [expanded, setExpanded] = useState(false)
  const [start, setStart] = useState<Starting>()
  const slash = folder.lastIndexOf('/')
  const parent = slash >= 0 ? folder.slice(0, slash) : ''
  const title = info?.manifest?.title || designName(folder)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !start && (e.stopPropagation(), setExpanded(false))
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [expanded, start])

  return (
    <SidePanel
      aria-label={`Design ${title}`}
      onClose={onClose}
      // Expanded over the whole page; the same element, so the page keeps its state.
      className={cn(
        expanded &&
          'inset-0 z-50 h-auto rounded-none border-0 xl:inset-0 xl:left-0 xl:z-50 xl:w-auto xl:border-l-0',
      )}
    >
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <Palette aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-semibold">{title}</strong>
          <span className="truncate text-xs text-muted-foreground">
            Design
            {info?.manifest?.designSystem && ` · ${info.manifest.designSystem}`}
            {info?.teammate && ` · by ${info.teammate.name}`}
            {parent && <span className="font-mono"> · {parent}</span>}
          </span>
        </div>
        {libraryLink && (
          <Button asChild variant="ghost" size="icon-sm" title="Open the library">
            <Link
              href={`/app/library?design=${encodeURIComponent(folder)}`}
              aria-label="Open the library"
            >
              <Library aria-hidden />
            </Link>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={expanded ? 'Back to the panel' : 'Expand'}
          aria-label={expanded ? 'Back to the panel' : 'Expand'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close design"
        >
          <X aria-hidden />
        </Button>
      </div>
      {info?.manifest?.description && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          {info.manifest.description}
        </p>
      )}
      <DesignFrame
        folder={folder}
        version={version}
        threadId={threadId}
        onInfo={setInfo}
        onStart={setStart}
      />
      {start && <StartThreadDialog start={start} onClose={() => setStart(undefined)} />}
    </SidePanel>
  )
}
