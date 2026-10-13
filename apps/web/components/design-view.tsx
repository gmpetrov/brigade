'use client'
// A design a teammate made, on its canvas: its pages from the sandbox origin
// (another site than the dashboard, no cookies, sandboxed documents) as boards
// that pan and zoom, an options set as one row per option. Beside a thread or
// the library, or expanded over the page. Around it: select an element and
// change its text, size, spacing and look by hand (saved into the page as a
// new version, by this member); ask the thread that made it about an element;
// knobs to try values and save them; export; hand-off to a thread that builds
// it. The pages and the canvas talk through the bridge the sandbox host adds to
// them (apps/api/src/design-bridge.ts), by postMessage only.
import {
  DESIGN_ENTRY,
  designBoards,
  designName,
  formatMention,
  screenHeight,
  type DesignEditOp,
  type DesignKnob,
  type DesignView as DesignViewInfo,
} from '@brigade/contracts'
import {
  Download,
  ExternalLink,
  Hammer,
  Library,
  Maximize,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MousePointer2,
  Palette,
  Pencil,
  Play,
  Redo2,
  RotateCw,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import {
  DesignCanvas,
  type CanvasBoard,
  type CanvasGroup,
  type CanvasHandle,
  type Inspected,
  type PageMessage,
  type Selected,
} from '@/components/design-canvas'
import { DesignEdits, type DesignChange } from '@/components/design-edits'
import { DesignProperties } from '@/components/design-properties'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

/** What a comment is about: an element on a board, else the whole design. */
type Target = {
  board: CanvasBoard
  element: Pick<Inspected, 'dataId' | 'path' | 'label' | 'line' | 'tag'> | null
}

/** A new thread to start, with its first message written. */
type Starting = { title: string; description: string; text: string; teammateId?: string }

/** Wide enough for the properties beside the canvas. */
const WIDE = 900

const mention = (folder: string) => formatMention({ kind: 'design', id: folder, label: folder })

function commentText(input: { folder: string; target: Target | null; body: string }) {
  const t = input.target
  const board = t
    ? ` on the board ${t.board.title ? `“${t.board.title}” (\`${t.board.file}\`, ` : `\`${t.board.file}\` (`}${t.board.width}px wide)`
    : ''
  const on = t?.element
    ? t.element.dataId
      ? `, on \`${t.element.dataId}\``
      : `, on the element \`${t.element.path}\``
    : ''
  const line = t?.element?.line ? ` at line ${t.element.line} of \`${t.board.file}\`` : ''
  const quote = t?.element?.label
    ? `\n\n> <${t.element.tag}> ${t.element.label.replace(/`/g, "'")}`
    : ''
  return `Comment on the design ${mention(input.folder)}${board}${on}${line}:${quote}\n\n${input.body.trim()}`
}

const handoffText = (folder: string) =>
  `Build the design ${mention(folder)} in the product. Match each of its boards, with the ` +
  "product's own components and conventions and the values in its knobs.json, then open a pull request."

function download(href: string, name: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.click()
}

/** A page of the design on the sandbox origin: the entry's address with its file in place. */
const pageUrl = (view: DesignViewInfo, file: string) =>
  view.url.slice(0, -DESIGN_ENTRY.length) + file.split('/').map(encodeURIComponent).join('/')

/** The undo of an op: what the element had before it, from what the page said about it. */
function undoOf(op: DesignEditOp, before: Inspected | undefined): DesignEditOp {
  if ('style' in op)
    return {
      id: op.id,
      style: Object.fromEntries(Object.keys(op.style).map((p) => [p, before?.inline[p] ?? null])),
    }
  if ('text' in op) return { id: op.id, text: before?.text ?? '' }
  return {
    id: op.id,
    attrs: Object.fromEntries(Object.keys(op.attrs).map((a) => [a, before?.attrs[a] ?? null])),
  }
}

/** An op as a message to the pages, to show it before it is saved. */
function live(op: DesignEditOp): Record<string, unknown> {
  if ('style' in op) return { type: 'brigade:style', bid: op.id, style: op.style }
  if ('text' in op) return { type: 'brigade:text', bid: op.id, text: op.text }
  return { type: 'brigade:attrs', bid: op.id, attrs: op.attrs }
}

/** The design's canvas and everything around it. `version` changes when its files do. */
function DesignFrame({
  folder,
  version,
  options,
  threadId,
  expanded,
  onExpand,
  onInfo,
  onStart,
}: {
  /** The design's library folder ("acme/pricing.design"). */
  folder: string
  version?: string
  /** The options offered with it, it included: one row each. */
  options?: string[]
  /** Shown beside this thread: comments go to it. */
  threadId?: string
  expanded: boolean
  onExpand?: () => void
  onInfo?: (info: DesignViewInfo) => void
  onStart: (start: Starting) => void
}) {
  const folders = useMemo(
    () => (options && options.length > 1 && options.includes(folder) ? options : [folder]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by their names
    [folder, options?.join('\n')],
  )
  const [views, setViews] = useState<Record<string, DesignViewInfo>>({})
  const [error, setError] = useState<string>()
  const [reloadAll, setReloadAll] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const canvas = useRef<CanvasHandle>(null)
  const [mode, setMode] = useState<'select' | 'play'>('select')
  const [selection, setSelection] = useState<Selected[]>([])
  const [inspected, setInspected] = useState<Record<string, Inspected>>({})
  const [tab, setTab] = useState<'properties' | 'ask' | 'knobs' | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ text: string; href?: string; error?: boolean }>()
  const [busy, setBusy] = useState<string>()
  const [slides, setSlides] = useState(0)
  const [, rerender] = useState(0)
  /** The version of the page each board shows. */
  const shown = useRef(new Map<string, string>())
  /** Each board's address: kept while its page is the one it shows, so a new view does not reload it. */
  const [srcs, setSrcs] = useState<Record<string, string>>({})
  const thumbnail = useRef<ReturnType<typeof setTimeout>>(undefined)
  const view = views[folder]

  const edits = useRef<DesignEdits>(null)
  edits.current ??= new DesignEdits({
    onSaved: (f, file) => {
      setNotice({ text: 'Saved.' })
      // The gallery's picture is the first board's.
      const first = canvasBoards().find((b) => b.folder === f)
      if (first?.file !== file) return
      clearTimeout(thumbnail.current)
      thumbnail.current = setTimeout(() => {
        canvas.current
          ?.capture(first.key, { ratio: 0.5, maxHeight: first.height ?? screenHeight(first.width) })
          .then(([image]) =>
            image
              ? api('/designs/thumbnail', {
                  method: 'PUT',
                  body: { path: f, png: image.data.slice(image.data.indexOf(',') + 1) },
                })
              : undefined,
          )
          .catch(() => undefined)
      }, 3000)
    },
    onLost: (f, file, message) => {
      setNotice({ text: message, error: true })
      canvas.current?.reload(f, file)
    },
    onChange: () => rerender((n) => n + 1),
  })
  const canvasBoards = () => canvas.current?.boards() ?? []

  useEffect(() => {
    let live = true
    setError(undefined)
    Promise.all(
      folders.map((f) =>
        api<DesignViewInfo>('/designs/view', { body: { path: f } }).then((v) => [f, v] as const),
      ),
    ).then(
      (loaded) => {
        if (!live) return
        const next = Object.fromEntries(loaded)
        setViews(next)
        setSrcs((before) => {
          const after: Record<string, string> = {}
          for (const [f, v] of loaded)
            designBoards(v.manifest).forEach((b, i) => {
              const key = `${f}#${i}`
              const sha = v.files[b.file]
              const was = shown.current.get(key)
              const keep =
                reloadAll === 0 &&
                before[key] &&
                sha &&
                (was === sha || edits.current!.own.has(sha))
              after[key] = keep ? before[key]! : pageUrl(v, b.file)
            })
          return after
        })
        for (const [f, v] of loaded)
          for (const [file, sha] of Object.entries(v.files)) edits.current!.seen(f, file, sha)
        const primary = next[folder]
        if (primary) {
          setValues(Object.fromEntries(primary.knobs.map((k) => [k.var, k.value])))
          onInfo?.(primary)
        }
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per design, version and reload
  }, [folders, version, reloadAll])

  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // What waits is saved when the canvas goes.
  useEffect(() => () => edits.current?.flushAll(), [])

  const groups: CanvasGroup[] = useMemo(
    () =>
      folders.flatMap((f) => {
        const v = views[f]
        if (!v) return []
        return [
          {
            key: f,
            title: v.manifest?.title || designName(f),
            boards: designBoards(v.manifest).map((b, i) => ({
              ...b,
              key: `${f}#${i}`,
              folder: f,
              src: srcs[`${f}#${i}`] ?? pageUrl(v, b.file),
            })),
          },
        ]
      }),
    [folders, views, srcs],
  )
  const boardByKey = (key: string) => groups.flatMap((g) => g.boards).find((b) => b.key === key)

  const wide = width >= WIDE
  const last = selection.at(-1)
  const lastInspected = last ? inspected[`${last.board}:${last.h}`] : undefined
  const lastBoard = last ? boardByKey(last.board) : undefined
  // The thread that made the design takes comments: this one, else the one that made it, if this member may write to it.
  const commentThread = threadId ?? (view?.thread?.mayPrompt ? view.thread.id : undefined)
  const panel = wide ? (tab ?? 'properties') : tab === 'properties' ? null : tab

  const onMessage = useCallback(
    (board: CanvasBoard, m: PageMessage) => {
      if (m.type === 'ready') {
        shown.current.set(board.key, String(m.sha))
        edits.current!.seen(board.folder, board.file, String(m.sha))
        if (board.folder === folder && board.key.endsWith('#0')) setSlides(Number(m.slides) || 0)
      } else if (m.type === 'inspected') {
        const element = m.element
        const key = `${board.key}:${element.h}`
        setInspected((all) => ({ ...all, [key]: element }))
        // A selection made by Escape (its parent) learns its number here.
        setSelection((all) =>
          all.map((s) =>
            s.board === board.key && s.h === element.h && s.bid !== element.bid
              ? { ...s, bid: element.bid }
              : s,
          ),
        )
      } else if (m.type === 'typed' && m.text !== null) {
        const element = inspected[`${board.key}:${m.h}`]
        change(board, [{ id: m.bid, text: m.text }], element)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest through state setters
    },
    [folder, inspected],
  )

  /** A person's change to one page: shown on every board of it at once, saved shortly, undoable. */
  function change(board: CanvasBoard, ops: DesignEditOp[], before?: Inspected, coalesce?: string) {
    const entry: DesignChange = {
      folder: board.folder,
      file: board.file,
      ops,
      undo: ops.map((op) => undoOf(op, before)),
      ...(coalesce
        ? { coalesce: `${board.key}:${ops.map((o) => o.id).join(',')}:${coalesce}` }
        : {}),
    }
    for (const op of ops) canvas.current?.postToFile(board.folder, board.file, live(op))
    edits.current!.push(entry)
    refreshInspected()
  }

  /** The panel shows what the pages say after a change. */
  function refreshInspected() {
    for (const s of selection) canvas.current?.post(s.board, { type: 'brigade:inspect', h: s.h })
  }

  function applyUndo(entry: DesignChange | null) {
    if (!entry) return
    for (const op of entry.ops) canvas.current?.postToFile(entry.folder, entry.file, live(op))
    refreshInspected()
  }

  /** A style for every selected element written in its page. */
  function onStyle(style: Record<string, string | null>, coalesce?: string) {
    for (const s of selection) {
      const board = boardByKey(s.board)
      const element = inspected[`${s.board}:${s.h}`]
      if (!board || s.bid === null || !element?.editable.style) continue
      change(board, [{ id: s.bid, style }], element, coalesce)
    }
  }

  function onAttrs(attrs: Extract<DesignEditOp, { attrs: unknown }>['attrs']) {
    if (!last || !lastBoard || last.bid === null || !lastInspected?.editable.attrs) return
    change(lastBoard, [{ id: last.bid, attrs }], lastInspected)
  }

  function onText(text: string) {
    if (!last || !lastBoard || last.bid === null || !lastInspected?.editable.text) return
    change(lastBoard, [{ id: last.bid, text }], lastInspected)
  }

  function onKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      applyUndo(e.shiftKey ? edits.current!.redo() : edits.current!.undo())
    } else if (e.key === 'Escape') {
      if (selection.length === 0) return
      e.preventDefault()
      const parent = lastInspected?.parent
      setSelection(
        parent !== null && parent !== undefined && last
          ? [{ board: last.board, h: parent, bid: null }]
          : [],
      )
    } else if ((e.key === 'Enter' || e.key === 'F2') && last && lastInspected?.editable.text) {
      e.preventDefault()
      canvas.current?.retype(last)
    }
  }

  // -- Export -----------------------------------------------------------------

  const name = designName(folder)
  const exportBoard = () =>
    lastBoard ?? canvasBoards().find((b) => b.folder === folder) ?? groups[0]?.boards[0]

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
      const board = exportBoard()
      if (!board) return
      const [image] = await canvas.current!.capture(board.key)
      if (image) download(image.data, `${name}-${board.file.replace(/\.html$/, '')}.png`)
    })

  const exportPptx = () =>
    exporting('Making the deck…', async () => {
      const board = groups.find((g) => g.key === folder)?.boards[0]
      if (!board) return
      const images = await canvas.current!.capture(board.key, { slides: true })
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

  // -- Comments ----------------------------------------------------------------

  const target: Target | null = lastBoard
    ? { board: lastBoard, element: lastInspected ?? null }
    : null
  const commentFolder = lastBoard?.folder ?? folder

  async function sendComment(body: string) {
    const text = commentText({ folder: commentFolder, target, body })
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

  // -- Knobs -------------------------------------------------------------------

  function setKnob(knob: DesignKnob, value: string) {
    setValues({ ...values, [knob.var]: value })
    for (const b of groups.find((g) => g.key === folder)?.boards ?? [])
      canvas.current?.post(b.key, { type: 'brigade:vars', vars: { [knob.var]: value } })
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
      setViews((all) => ({ ...all, [folder]: { ...view, knobs } }))
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
    for (const b of groups.find((g) => g.key === folder)?.boards ?? [])
      canvas.current?.post(b.key, { type: 'brigade:vars', vars: saved })
  }

  // A page that loads again gets the knob values being tried.
  const tried = useRef(values)
  tried.current = values
  const onPage = useCallback(
    (board: CanvasBoard, m: PageMessage) => {
      if (m.type === 'ready' && board.folder === folder && changed.length)
        canvas.current?.post(board.key, { type: 'brigade:vars', vars: tried.current })
      onMessage(board, m)
    },
    [folder, changed.length, onMessage],
  )

  const shared =
    !!lastBoard &&
    groups
      .flatMap((g) => g.boards)
      .filter((b) => b.folder === lastBoard.folder && b.file === lastBoard.file).length > 1
  const knobsPanel = view && view.knobs.length > 0 && (
    <Knobs
      knobs={view.knobs}
      values={values}
      onChange={setKnob}
      changed={changed.length}
      busy={Boolean(busy)}
      onSave={() => void saveKnobs()}
      onReset={resetKnobs}
    />
  )
  const askBox = view && (
    <CommentBox
      target={target}
      to={
        commentThread === threadId && threadId
          ? 'this thread'
          : commentThread
            ? `“${view.thread?.title}”`
            : 'a new thread'
      }
      onClear={() => setSelection([])}
      onSend={sendComment}
    />
  )

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
        <div role="radiogroup" aria-label="Mode" className="flex rounded-md bg-muted p-0.5">
          {(
            [
              ['select', MousePointer2, 'Select: pick elements to change or ask about'],
              ['play', Play, 'Play: use the pages'],
            ] as const
          ).map(([m, Icon, title]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              title={title}
              onClick={() => {
                setMode(m)
                if (m === 'play') setSelection([])
              }}
              className={cn(
                'flex size-7 items-center justify-center rounded',
                mode === m
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon aria-hidden className="size-3.5" />
              <span className="sr-only">{m}</span>
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Fit everything (⇧1)"
          aria-label="Fit everything"
          onClick={() => canvas.current?.fit()}
        >
          <Maximize aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Undo (⌘Z)"
          aria-label="Undo"
          disabled={!edits.current.canUndo}
          onClick={() => applyUndo(edits.current!.undo())}
        >
          <Undo2 aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Redo (⇧⌘Z)"
          aria-label="Redo"
          disabled={!edits.current.canRedo}
          onClick={() => applyUndo(edits.current!.redo())}
        >
          <Redo2 aria-hidden />
        </Button>
        <span className="text-xs text-muted-foreground">{edits.current.busy ? 'Saving…' : ''}</span>
        <span className="flex-1" />
        {!wide && (
          <>
            <Button
              type="button"
              variant={tab === 'ask' ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={tab === 'ask'}
              disabled={!view}
              onClick={() => setTab(tab === 'ask' ? null : 'ask')}
            >
              <MessageSquarePlus aria-hidden />
              Comment
            </Button>
            {view && view.knobs.length > 0 && (
              <Button
                type="button"
                variant={tab === 'knobs' ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={tab === 'knobs'}
                onClick={() => setTab(tab === 'knobs' ? null : 'knobs')}
              >
                <SlidersHorizontal aria-hidden />
                Knobs
              </Button>
            )}
            {onExpand && !expanded && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title="Edit by hand: expand the design"
                onClick={onExpand}
              >
                <Pencil aria-hidden />
                Edit
              </Button>
            )}
          </>
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
            <DropdownMenuItem
              disabled={!view}
              onSelect={() => {
                const board = exportBoard()
                if (board) canvas.current?.post(board.key, { type: 'brigade:print' })
              }}
            >
              PDF (print)
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!view} onSelect={() => void exportPng()}>
              Image (.png), {lastBoard ? 'the selected board' : 'the first board'}
            </DropdownMenuItem>
            {slides > 0 && (
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
          onClick={() => {
            setSelection([])
            shown.current.clear()
            setReloadAll((n) => n + 1)
          }}
        >
          <RotateCw aria-hidden />
        </Button>
        {view && (
          <Button asChild variant="ghost" size="icon-sm" title="Open in a new tab">
            <a
              href={lastBoard ? (srcs[lastBoard.key] ?? view.url) : view.url}
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

      {!wide && tab === 'knobs' && knobsPanel}

      <div className="flex min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-sm text-destructive-text">{error}</p>
        ) : groups.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <DesignCanvas
            handle={canvas}
            groups={groups}
            mode={mode}
            selection={selection}
            onSelect={setSelection}
            onMessage={onPage}
            onKeyDown={onKeyDown}
            onDoubleClick={(s) => {
              if (inspected[`${s.board}:${s.h}`]?.editable.text) canvas.current?.retype(s)
            }}
          />
        )}

        {wide && view && (
          <aside aria-label="Properties" className="flex w-[300px] shrink-0 flex-col border-l">
            <div role="tablist" className="flex gap-1 border-b px-2 py-1.5">
              {(
                [
                  ['properties', 'Properties'],
                  ['ask', 'Ask'],
                  ...(view.knobs.length ? ([['knobs', 'Knobs']] as const) : []),
                ] as const
              ).map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={panel === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'rounded-md px-2 py-1 text-xs',
                    panel === t
                      ? 'bg-secondary font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {panel === 'knobs' ? (
              knobsPanel
            ) : panel === 'ask' ? (
              askBox
            ) : lastInspected ? (
              <DesignProperties
                element={lastInspected}
                count={selection.length}
                shared={shared}
                {...(view.teammate ? { teammate: view.teammate.name } : {})}
                onStyle={onStyle}
                onAttrs={onAttrs}
                onText={onText}
                onAsk={() => setTab('ask')}
              />
            ) : (
              <p className="p-3 text-xs text-muted-foreground">
                {mode === 'play'
                  ? 'Play: the pages work as they would in a browser. Switch to Select to change them.'
                  : 'Select an element on a board to change its text, size, spacing and look. Space + drag or the trackpad pans, pinch or ⌘ + scroll zooms, ⇧1 fits everything.'}
              </p>
            )}
          </aside>
        )}
      </div>

      {!wide && tab === 'ask' && askBox}
    </div>
  )
}

function CommentBox({
  target,
  to,
  onClear,
  onSend,
}: {
  target: Target | null
  to: string
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
        {target ? (
          <>
            <span className="text-muted-foreground">On</span>
            <code
              className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5"
              title={target.element?.path}
            >
              {target.element
                ? (target.element.dataId ?? target.element.tag)
                : (target.board.title ?? target.board.file)}
            </code>
            {target.element?.label && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                “{target.element.label}”
              </span>
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
            On the whole design. Select an element to point at it.
          </span>
        )}
      </div>
      <Textarea
        aria-label="Comment"
        value={body}
        rows={3}
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
        <span className="truncate text-xs text-muted-foreground">To {to}</span>
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
    <div className="flex max-h-[40%] flex-col gap-3 overflow-y-auto border-b px-3 py-3 data-[wide]:max-h-none">
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
  options,
}: {
  folder: string
  version?: string
  /** Shown beside this thread: comments go to it. */
  threadId?: string
  onClose: () => void
  /** A button to the design in the library (not when already there). */
  libraryLink?: boolean
  /** The options offered with this one, it included: shown side by side, a row each. */
  options?: string[]
}) {
  const [info, setInfo] = useState<DesignViewInfo>()
  const [expanded, setExpanded] = useState(false)
  const [start, setStart] = useState<Starting>()
  // Another design: its title, not the last one's, until it loads.
  const [shown, setShown] = useState(folder)
  if (shown !== folder) {
    setShown(folder)
    setInfo(undefined)
  }
  const slash = folder.lastIndexOf('/')
  const parent = slash >= 0 ? folder.slice(0, slash) : ''
  const title = info?.manifest?.title || designName(folder)
  const set = options && options.length > 1

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      // The canvas takes Escape while something is selected on it.
      if (e.key !== 'Escape' || start || e.defaultPrevented) return
      e.stopPropagation()
      setExpanded(false)
    }
    // As the key comes back up: after the canvas had it.
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, start])

  return (
    <SidePanel
      aria-label={`Design ${title}`}
      onClose={onClose}
      raiseKey={folder}
      // Expanded over the whole page; the same element, so the page keeps its state.
      className={cn(
        expanded &&
          'inset-0 z-50 h-auto rounded-none border-0 xl:inset-0 xl:left-0 xl:z-50 xl:w-auto xl:border-l-0',
      )}
    >
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <Palette aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-semibold">
            {set
              ? `${options.length} options for ${designName(parent.replace(/\.options$/, '.design'))}`
              : title}
          </strong>
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
      {!set && info?.manifest?.description && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          {info.manifest.description}
        </p>
      )}
      <DesignFrame
        folder={folder}
        version={version}
        {...(set ? { options } : {})}
        threadId={threadId}
        expanded={expanded}
        onExpand={() => setExpanded(true)}
        onInfo={setInfo}
        onStart={setStart}
      />
      {start && <StartThreadDialog start={start} onClose={() => setStart(undefined)} />}
    </SidePanel>
  )
}
