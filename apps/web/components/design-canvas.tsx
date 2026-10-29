'use client'
// The canvas a design opens on: its boards (its pages, each at a size) laid out
// in a world that pans and zooms. A board is its page from the sandbox origin
// in a frame; the bridge in the page (apps/api/src/design-bridge.ts) says what
// is under the pointer, what an element is and how tall the page is, by
// postMessage only. In Select a clear layer over each board takes the pointer,
// so the page gets no clicks and the canvas asks the page what is under it; in
// Play the pages work. Outlines and titles are drawn above the world, in screen
// pixels, so they stay sharp at any zoom. Only a few boards are live at once
// (those filling most of the view, once it holds still); the others, and boards
// too small on screen to use, show a picture taken of their page.
import { BOARD_HEIGHT_MAX, screenHeight, type PlacedBoard } from '@brigade/contracts'
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react'
import { blobOfDataUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

export type Rect = { x: number; y: number; width: number; height: number }

/** An element of a page, as the bridge describes it. `h` is its handle in that page, for this load. */
export type PageElement = {
  h: number
  /** Its number in the page's source; null when the page's script made it. */
  bid: number | null
  tag: string
  label: string
  rect: Rect
}

/** What the properties panel shows about an element. */
export type Inspected = PageElement & {
  line: number | null
  dataId: string | null
  path: string
  /** Its text, when it holds no other element. */
  text: string | null
  computed: Record<string, string>
  inline: Record<string, string>
  attrs: Record<string, string>
  editable: { style: boolean; attrs: boolean; text: boolean }
  scripted: boolean
  parent: number | null
}

export type Captured = { data: string; width: number; height: number; notes: string }

/** A board as the canvas gets it: a page of a design (`folder`), placed within its group. */
export type CanvasBoard = PlacedBoard & {
  key: string
  folder: string
  /** The page on the sandbox origin. */
  src: string
}

/** A design among the ones shown (an options set shows several), its boards in a row. */
export type CanvasGroup = { key: string; title?: string; boards: CanvasBoard[] }

/** A selected element: its board, its handle in that page, its number in the page's source. */
export type Selected = { board: string; h: number; bid: number | null }

/** Messages from a page the view handles. */
export type PageMessage =
  | { type: 'ready'; sha: string; file: string; slides: number }
  | { type: 'inspected'; element: Inspected }
  | { type: 'typed'; h: number; bid: number; text: string | null }

export type CanvasHandle = {
  /** Send a message to a board's page. */
  post: (board: string, message: Record<string, unknown>) => void
  /** Send a message to every board showing this page. */
  postToFile: (folder: string, file: string, message: Record<string, unknown>) => void
  /** Load a page again, on every board showing it (all of a design without `file`). */
  reload: (folder: string, file?: string) => void
  capture: (
    board: string,
    options?: { slides?: boolean; ratio?: number; maxHeight?: number },
  ) => Promise<Captured[]>
  /** Retype an element's text in place, in its page. */
  retype: (selected: Selected) => void
  fit: (what?: 'all' | 'selection') => void
  boards: () => CanvasBoard[]
}

type FromPage =
  | PageMessage
  | { type: 'hit'; seq: number; element: PageElement | null }
  | { type: 'rects'; rects: Record<string, Rect | null> }
  | {
      type: 'size'
      height: number
      frame: number
      width?: number
      frameWidth?: number
      resized: boolean
    }
  | { type: 'wheel'; dx: number; dy: number; zoom: boolean; x: number; y: number; lines: boolean }
  | { type: 'scrolled'; dx: number; dy: number }
  | { type: 'captured'; id: string; images?: Captured[]; error?: string }

/** Messages that change what a page shows. */
const CHANGES = new Set(['brigade:style', 'brigade:text', 'brigade:attrs', 'brigade:vars'])

/** Space above a group of boards for its name. */
const GROUP_TITLE = 72
const GROUP_GAP = 200
/**
 * Boards that show their live page at once: each is a whole document in a frame, laid out,
 * painted and run, and each zoom paints them all again. The others show a picture of their page.
 * A phone ends the tab past a few.
 */
const LIVE_MAX = 6
const LIVE_MAX_TOUCH = 2
/** Narrower than this on screen, a board that has a picture shows it rather than its page. */
const PICTURE_BELOW = 400
/** How wide a board's picture is taken, at most. */
const PICTURE_WIDTH = 800
/** How long the view holds still before boards change between page and picture. */
const SETTLE_MS = 200
const ZOOM_MIN = 0.02
/** The widest a board grows to fit its page: the widest a design may set. */
const BOARD_WIDTH_MAX = 4000
const ZOOM_MAX = 4
/** What the frame of a board is set to before its page says how tall it is. */
const startHeight = (board: PlacedBoard) => board.height ?? screenHeight(board.width)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const selectedKey = (s: Selected) => `${s.board}:${s.h}`

/** How a board's height settles: see onSize. */
type Sizing = { phase: 'initial' | 'checking' | 'whole' | 'scrolls' }

function DesignCanvasInner({
  groups,
  mode,
  selection,
  onSelect,
  onMessage,
  onKeyDown,
  onDoubleClick,
  handle,
  className,
}: {
  groups: CanvasGroup[]
  mode: 'select' | 'play'
  selection: Selected[]
  onSelect: (selection: Selected[]) => void
  onMessage: (board: CanvasBoard, message: PageMessage) => void
  /** Keys the canvas does not take itself (Escape, undo). */
  onKeyDown?: (e: ReactKeyboardEvent) => void
  onDoubleClick?: (selected: Selected) => void
  handle?: Ref<CanvasHandle>
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [touch, setTouch] = useState(false)
  useEffect(() => setTouch(window.matchMedia('(pointer: coarse)').matches), [])
  const [view, setView] = useState({ x: 40, y: 40, zoom: 0.25 })
  const viewRef = useRef(view)
  viewRef.current = view
  // The view once it holds still: which boards are live follows it, not each step of a gesture.
  const [settled, setSettled] = useState(view)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(view), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [view])
  /** Boards whose page said it is ready, since their frame last loaded. */
  const [ready, setReady] = useState<Record<string, boolean>>({})
  const readyRef = useRef(ready)
  readyRef.current = ready
  const waiting = useRef(new Map<string, (() => void)[]>())
  /** Each board's picture (a blob: URL), and the page version it shows. */
  const [pictures, setPictures] = useState<Record<string, { url: string; sha: string }>>({})
  const picturesRef = useRef(pictures)
  picturesRef.current = pictures
  /** Boards whose page changed since their picture was taken. */
  const stale = useRef(new Set<string>())
  const shas = useRef(new Map<string, string>())
  /** Boards kept live whatever the view: one being captured for an export. */
  const [pinned, setPinned] = useState<string[]>([])
  const [, recheck] = useState(0)
  const [heights, setHeights] = useState<Record<string, number>>({})
  // Boards whose page is wider than they are: drawn as wide as the page, not cut at their edge.
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [scrolling, setScrolling] = useState<Record<string, boolean>>({})
  const sizing = useRef(new Map<string, Sizing>())
  const [reloads, setReloads] = useState<Record<string, number>>({})
  const [hover, setHover] = useState<{ board: string; element: PageElement } | null>(null)
  const [rects, setRects] = useState<Record<string, Rect | null>>({})
  const [retyping, setRetyping] = useState<Selected | null>(null)
  const [panning, setPanning] = useState<'space' | 'drag' | null>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const seqs = useRef({
    next: 1,
    hover: new Map<string, number>(),
    select: new Map<number, boolean>(),
  })
  const captures = useRef(new Map<string, (m: Extract<FromPage, { type: 'captured' }>) => void>())
  const fitted = useRef(false)

  // Groups one under the other, each under its name; boards in a group where it put them.
  const layout = useMemo(() => {
    // `frame`: how tall the board is drawn; `height` stays the one the design set, if any.
    const boards: (CanvasBoard & { group: string; frame: number })[] = []
    const titles: { key: string; title: string; x: number; y: number; width: number }[] = []
    let top = 0
    for (const group of groups) {
      if (group.boards.length === 0) continue
      const titled = groups.length > 1 && group.title
      const y0 = top + (titled ? GROUP_TITLE : 0)
      let bottom = y0
      let right = 0
      // A board drawn wider pushes the boards after it in its row along by as much.
      const extra = (b: CanvasBoard) => Math.max(0, (widths[b.key] ?? b.width) - b.width)
      for (const b of group.boards) {
        const frame = heights[b.key] ?? startHeight(b)
        const shift = group.boards
          .filter((o) => o.y === b.y && o.x < b.x)
          .reduce((sum, o) => sum + extra(o), 0)
        const width = b.width + extra(b)
        boards.push({ ...b, x: b.x + shift, y: y0 + b.y, width, group: group.key, frame })
        bottom = Math.max(bottom, y0 + b.y + frame)
        right = Math.max(right, b.x + shift + width)
      }
      // At the top of its boards: drawn just above their titles.
      if (titled) titles.push({ key: group.key, title: group.title!, x: 0, y: y0, width: right })
      top = bottom + GROUP_GAP
    }
    return { boards, titles }
  }, [groups, heights, widths])
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const boardOf = useCallback(
    (key: string) => layoutRef.current.boards.find((b) => b.key === key),
    [],
  )

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry!.contentRect.width, height: entry!.contentRect.height }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const post = useCallback((board: string, message: Record<string, unknown>) => {
    // A change to the page: its picture is taken again.
    if (CHANGES.has(String(message.type)) && picturesRef.current[board]) {
      stale.current.add(board)
      recheck((n) => n + 1)
    }
    // The page's origin is opaque: '*' is the only target; what is sent is not secret.
    frames.current.get(board)?.contentWindow?.postMessage(message, '*')
  }, [])

  // -- Pan and zoom -----------------------------------------------------------

  const zoomAt = useCallback((x: number, y: number, factor: number) => {
    fitted.current = true
    setView((v) => {
      const zoom = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX)
      const k = zoom / v.zoom
      return { zoom, x: x - (x - v.x) * k, y: y - (y - v.y) * k }
    })
  }, [])
  const panBy = useCallback((dx: number, dy: number) => {
    fitted.current = true
    setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
  }, [])

  const fitTo = useCallback(
    (rect: Rect | null, most = 1) => {
      if (!rect || !size.width) return
      const pad = 48
      const zoom = clamp(
        Math.min((size.width - pad * 2) / rect.width, (size.height - pad * 2) / rect.height, most),
        ZOOM_MIN,
        ZOOM_MAX,
      )
      setView({
        zoom,
        x: (size.width - rect.width * zoom) / 2 - rect.x * zoom,
        y: Math.max(pad, (size.height - rect.height * zoom) / 2) - rect.y * zoom,
      })
    },
    [size],
  )
  const bounds = useCallback((items: Rect[]): Rect | null => {
    if (items.length === 0) return null
    const x = Math.min(...items.map((r) => r.x))
    const y = Math.min(...items.map((r) => r.y))
    return {
      x,
      y,
      width: Math.max(...items.map((r) => r.x + r.width)) - x,
      height: Math.max(...items.map((r) => r.y + r.height)) - y,
    }
  }, [])
  const allBounds = useCallback(
    () =>
      bounds([
        ...layoutRef.current.boards.map((b) => ({
          x: b.x,
          y: b.y - 28,
          width: b.width,
          height: b.frame + 28,
        })),
        ...layoutRef.current.titles.map((t) => ({
          x: t.x,
          y: t.y - GROUP_TITLE,
          width: t.width,
          height: GROUP_TITLE,
        })),
      ]),
    [bounds],
  )
  const selectionBounds = useCallback(() => {
    const items = selection.flatMap((s) => {
      const board = boardOf(s.board)
      const r = rects[selectedKey(s)]
      return board && r ? [{ ...r, x: board.x + r.x, y: board.y + r.y }] : []
    })
    return bounds(items)
  }, [selection, rects, boardOf, bounds])

  // Fit everything once the boards are laid out, and again as they settle and the canvas changes
  // size (expanded), until the person moves the view themselves.
  useEffect(() => {
    if (fitted.current || !size.width || layout.boards.length === 0) return
    fitTo(allBounds())
  }, [size.width, size.height, layout, fitTo, allBounds])

  /** A wheel over the canvas, or forwarded by a page: x, y on the canvas. */
  const wheel = useCallback(
    (x: number, y: number, dx: number, dy: number, zoom: boolean, board?: string) => {
      if (zoom) return zoomAt(x, y, Math.exp(-clamp(dy, -60, 60) * 0.01))
      // Over a page that scrolls inside its board: the page first, the canvas with what is left.
      if (
        board &&
        layoutRef.current.boards.some((b) => b.key === board) &&
        scrollingRef.current[board]
      ) {
        const z = viewRef.current.zoom
        return post(board, { type: 'brigade:scroll', dx: dx / z, dy: dy / z })
      }
      panBy(dx, dy)
    },
    [zoomAt, panBy, post],
  )
  const scrollingRef = useRef(scrolling)
  scrollingRef.current = scrolling

  useEffect(() => {
    const element = box.current
    if (!element) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = element.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1
      const board = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-board]')?.dataset
        .board
      wheel(
        e.clientX - r.left,
        e.clientY - r.top,
        e.deltaX * unit,
        e.deltaY * unit,
        e.ctrlKey || e.metaKey,
        board,
      )
    }
    // Safari's pinch.
    let last = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      last = 1
    }
    const onGesture = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      const r = element.getBoundingClientRect()
      zoomAt(g.clientX - r.left, g.clientY - r.top, g.scale / last)
      last = g.scale
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('gesturestart', onGestureStart)
    element.addEventListener('gesturechange', onGesture)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('gesturestart', onGestureStart)
      element.removeEventListener('gesturechange', onGesture)
    }
  }, [wheel, zoomAt])

  // Space + drag pans, wherever the pointer is.
  useEffect(() => {
    const element = box.current
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !element?.contains(document.activeElement)) return
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      setPanning((p) => p ?? 'space')
    }
    const up = (e: KeyboardEvent) =>
      e.code === 'Space' && setPanning((p) => (p === 'space' ? null : p))
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  function startDrag(e: React.PointerEvent) {
    fitted.current = true
    const start = { x: e.clientX, y: e.clientY, view: viewRef.current }
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) =>
      setView({
        ...start.view,
        x: start.view.x + m.clientX - start.x,
        y: start.view.y + m.clientY - start.y,
      })
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      setPanning((p) => (p === 'drag' ? null : p))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  // -- The pages' messages ----------------------------------------------------

  /**
   * A board without a height of its own grows to its page. It starts a screen tall (what `100vh`
   * is); when the page is taller, the frame grows to it and the page measures again: a page that
   * grew with the frame is sized by it, and keeps a screen's height, scrolling inside.
   */
  const onSize = useCallback(
    (key: string, height: number, frame: number, resized: boolean) => {
      const board = boardOf(key)
      if (!board || board.height) return
      const screen = screenHeight(board.width)
      const current = heights[key] ?? screen
      // Measured in a frame of another height: the next report is the one.
      if (Math.abs(frame - current) > 1) return
      const s = sizing.current.get(key) ?? { phase: 'initial' }
      sizing.current.set(key, s)
      const set = (h: number, scrolls: boolean) => {
        setHeights((all) => (all[key] === h ? all : { ...all, [key]: h }))
        setScrolling((all) => (all[key] === scrolls ? all : { ...all, [key]: scrolls }))
      }
      if (s.phase === 'scrolls') return
      if (s.phase === 'checking' && resized && height > current + 1) {
        s.phase = 'scrolls'
        return set(screen, true)
      }
      if (Math.abs(height - current) <= 1) return void (s.phase = 'whole')
      if (height > BOARD_HEIGHT_MAX) {
        s.phase = 'scrolls'
        return set(BOARD_HEIGHT_MAX, true)
      }
      s.phase = height > current ? 'checking' : 'whole'
      set(Math.max(200, height), false)
    },
    [boardOf, heights],
  )
  /**
   * A page wider than its board (a fixed 1440px layout on a 1280px board) widens the board to it,
   * up to the widest a board may be. Measured in a frame of another width, the next report counts.
   */
  const onWidth = useCallback(
    (key: string, width: number, frame: number) => {
      const board = boardOf(key)
      if (!board || !width || Math.abs(frame - board.width) > 1) return
      if (width <= board.width + 1) return
      const wider = Math.min(BOARD_WIDTH_MAX, Math.ceil(width))
      setWidths((all) => (all[key] === wider ? all : { ...all, [key]: wider }))
    },
    [boardOf],
  )
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  useEffect(() => {
    const onWindowMessage = (e: MessageEvent) => {
      let key: string | undefined
      for (const [k, frame] of frames.current) if (frame.contentWindow === e.source) key = k
      if (!key) return
      const m = e.data as FromPage & { source?: string }
      if (m?.source !== 'brigade-design') return
      const board = boardOf(key)
      if (!board) return
      // The page's own script could send these too: they only ever fill the canvas.
      if (m.type === 'hit') {
        const select = seqs.current.select.get(m.seq)
        if (select !== undefined) {
          seqs.current.select.delete(m.seq)
          const element = m.element
          if (!element) return
          const picked = {
            board: key,
            h: Number(element.h),
            bid: typeof element.bid === 'number' ? element.bid : null,
          }
          setRects((all) => ({ ...all, [selectedKey(picked)]: element.rect }))
          const current = selectionRef.current
          onSelectRef.current(
            select
              ? current.some((s) => selectedKey(s) === selectedKey(picked))
                ? current.filter((s) => selectedKey(s) !== selectedKey(picked))
                : [...current, picked]
              : [picked],
          )
        } else if (seqs.current.hover.get(key) === m.seq) {
          setHover(m.element ? { board: key, element: m.element } : null)
        }
      } else if (m.type === 'rects') {
        setRects((all) => {
          const next = { ...all }
          for (const [h, r] of Object.entries(m.rects ?? {})) next[`${key}:${h}`] = r
          return next
        })
      } else if (m.type === 'size') {
        onWidth(key, Number(m.width) || 0, Number(m.frameWidth) || 0)
        onSizeRef.current(key, Number(m.height) || 0, Number(m.frame) || 0, Boolean(m.resized))
      } else if (m.type === 'wheel') {
        const v = viewRef.current
        const unit = m.lines ? 16 : 1
        wheel(
          v.x + (board.x + Number(m.x)) * v.zoom,
          v.y + (board.y + Number(m.y)) * v.zoom,
          Number(m.dx) * unit * v.zoom,
          Number(m.dy) * unit * v.zoom,
          Boolean(m.zoom),
        )
      } else if (m.type === 'scrolled') {
        const z = viewRef.current.zoom
        panBy(Number(m.dx) * z || 0, Number(m.dy) * z || 0)
      } else if (m.type === 'captured') {
        captures.current.get(String(m.id))?.(m)
        captures.current.delete(String(m.id))
      } else if (m.type === 'typed') {
        stale.current.add(key)
        setRetyping(null)
        onMessageRef.current(board, m)
      } else if (m.type === 'ready') {
        shas.current.set(key, String(m.sha))
        setReady((all) => (all[key] ? all : { ...all, [key]: true }))
        for (const resolve of waiting.current.get(key) ?? []) resolve()
        waiting.current.delete(key)
        post(key, { type: 'brigade:canvas', play: modeRef.current === 'play' })
        onMessageRef.current(board, m)
      } else if (m.type === 'inspected') {
        onMessageRef.current(board, m)
      }
    }
    window.addEventListener('message', onWindowMessage)
    return () => window.removeEventListener('message', onWindowMessage)
  }, [boardOf, post, wheel, panBy])

  const modeRef = useRef(mode)
  modeRef.current = mode
  useEffect(() => {
    for (const key of frames.current.keys())
      post(key, { type: 'brigade:canvas', play: mode === 'play' })
    if (mode === 'play') setHover(null)
  }, [mode, post])

  // The pages keep the selection's rects coming, and say what is selected.
  const selectionKey = selection.map(selectedKey).join(',')
  useEffect(() => {
    const byBoard = new Map<string, number[]>()
    for (const s of selection) byBoard.set(s.board, [...(byBoard.get(s.board) ?? []), s.h])
    for (const key of frames.current.keys())
      post(key, { type: 'brigade:watch', hs: byBoard.get(key) ?? [] })
    for (const s of selection.slice(-20)) post(s.board, { type: 'brigade:inspect', h: s.h })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by what is selected
  }, [selectionKey, post])

  // -- The view's handle ------------------------------------------------------

  const captureBoard = useCallback(
    (board: string, options: { slides?: boolean; ratio?: number; maxHeight?: number }) => {
      const id = Math.random().toString(36).slice(2)
      return new Promise<Captured[]>((resolve, reject) => {
        if (!frames.current.has(board)) return reject(new Error('Show the board first'))
        const timer = setTimeout(() => {
          captures.current.delete(id)
          reject(new Error('The page did not answer. Reload it and try again.'))
        }, 60_000)
        captures.current.set(id, (m) => {
          clearTimeout(timer)
          if (m.error || !m.images) reject(new Error(m.error ?? 'Nothing was captured'))
          else resolve(m.images)
        })
        post(board, { type: 'brigade:capture', id, ...options })
      })
    },
    [post],
  )

  useImperativeHandle(
    handle,
    () => ({
      post,
      postToFile: (folder, file, message) => {
        for (const b of layoutRef.current.boards)
          if (b.folder === folder && b.file === file) post(b.key, message)
      },
      reload: (folder, file) => {
        const keys = layoutRef.current.boards
          .filter((b) => b.folder === folder && (!file || b.file === file))
          .map((b) => b.key)
        for (const key of keys) {
          sizing.current.delete(key)
          stale.current.add(key)
        }
        setReloads((all) => ({
          ...all,
          ...Object.fromEntries(keys.map((k) => [k, (all[k] ?? 0) + 1])),
        }))
      },
      capture: async (board, options = {}) => {
        if (readyRef.current[board]) return captureBoard(board, options)
        // A board showing its picture: its page loads for the capture, then goes.
        setPinned((all) => [...all, board])
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('The page did not load. Reload it and try again.')),
              60_000,
            )
            waiting.current.set(board, [
              ...(waiting.current.get(board) ?? []),
              () => {
                clearTimeout(timer)
                resolve()
              },
            ])
          })
          return await captureBoard(board, options)
        } finally {
          setPinned((all) => {
            const i = all.indexOf(board)
            return i < 0 ? all : [...all.slice(0, i), ...all.slice(i + 1)]
          })
        }
      },
      retype: (selected) => {
        setRetyping(selected)
        frames.current.get(selected.board)?.focus()
        post(selected.board, { type: 'brigade:edit-text', h: selected.h })
      },
      fit: (what = 'all') =>
        fitTo(what === 'selection' ? (selectionBounds() ?? allBounds()) : allBounds()),
      boards: () => layoutRef.current.boards,
    }),
    [post, fitTo, selectionBounds, allBounds, captureBoard],
  )

  // -- Pointer over a board in Select -----------------------------------------

  /** Where the pointer is in a board's page: the layer over it is scaled with the world. */
  const pagePoint = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const z = viewRef.current.zoom
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z }
  }
  const hoverFrame = useRef(0)
  function onOverlayMove(e: React.MouseEvent, board: string) {
    if (!frames.current.has(board)) return
    const point = pagePoint(e)
    cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = requestAnimationFrame(() => {
      const seq = seqs.current.next++
      seqs.current.hover.set(board, seq)
      post(board, { type: 'brigade:hit', seq, ...point })
    })
  }
  function onOverlayClick(e: React.MouseEvent, board: string) {
    // A board showing its picture: brought close, where its page loads.
    if (!frames.current.has(board)) {
      const b = boardOf(board)
      if (b) fitTo({ x: b.x, y: b.y, width: b.width, height: b.frame })
      fitted.current = true
      return
    }
    const seq = seqs.current.next++
    seqs.current.select.set(seq, e.shiftKey)
    post(board, { type: 'brigade:hit', seq, ...pagePoint(e) })
    box.current?.focus({ preventScroll: true })
  }

  function onKey(e: ReactKeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
    const mod = e.metaKey || e.ctrlKey
    if (e.shiftKey && e.code === 'Digit1') {
      e.preventDefault()
      fitTo(allBounds())
    } else if (e.shiftKey && e.code === 'Digit2') {
      e.preventDefault()
      fitTo(selectionBounds() ?? allBounds())
    } else if (mod && e.code === 'Digit0') {
      e.preventDefault()
      zoomAt(size.width / 2, size.height / 2, 1 / viewRef.current.zoom)
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      zoomAt(size.width / 2, size.height / 2, 1.25)
    } else if (mod && e.key === '-') {
      e.preventDefault()
      zoomAt(size.width / 2, size.height / 2, 0.8)
    } else onKeyDown?.(e)
  }

  // -- Drawing ----------------------------------------------------------------

  const screen = (x: number, y: number) => ({
    left: view.x + x * view.zoom,
    top: view.y + y * view.zoom,
  })
  // Live: the boards that fill most of the view, up to a few; a board kept small on screen shows its
  // picture once it has one; a selected one, or one being retyped or captured, stays live.
  const keep = [...selection.map((x) => x.board), ...(retyping ? [retyping.board] : []), ...pinned]
  const keepKey = keep.join(',')
  const live = useMemo(() => {
    const v = settled
    const margin = touch ? 0 : 0.25
    const mx = size.width * margin
    const my = size.height * margin
    const kept = new Set(keepKey ? keepKey.split(',') : [])
    const ranked = layout.boards.flatMap((b) => {
      if (kept.has(b.key)) return [{ key: b.key, rank: Infinity }]
      const left = v.x + b.x * v.zoom
      const top = v.y + b.y * v.zoom
      const w = b.width * v.zoom
      const h = b.frame * v.zoom
      const across = Math.min(size.width + mx, left + w) - Math.max(-mx, left)
      const down = Math.min(size.height + my, top + h) - Math.max(-my, top)
      if (across <= 0 || down <= 0) return []
      if (w < PICTURE_BELOW && pictures[b.key]) return []
      return [{ key: b.key, rank: across * down }]
    })
    return new Set(
      ranked
        .sort((x, y) => y.rank - x.rank)
        .slice(0, Math.max(kept.size, touch ? LIVE_MAX_TOUCH : LIVE_MAX))
        .map((r) => r.key),
    )
  }, [settled, touch, size.width, size.height, layout.boards, pictures, keepKey])

  // A live board whose page is ready and has no picture of this version: its picture is taken,
  // one board at a time, once the view holds still.
  const taking = useRef(false)
  useEffect(() => {
    if (taking.current) return
    const key = [...live].find(
      (k) =>
        ready[k] &&
        k !== retyping?.board &&
        (!pictures[k] || stale.current.has(k) || pictures[k].sha !== shas.current.get(k)),
    )
    if (!key) return
    const timer = setTimeout(async () => {
      const board = boardOf(key)
      if (!board || !frames.current.has(key)) return
      taking.current = true
      stale.current.delete(key)
      const sha = shas.current.get(key) ?? ''
      try {
        const [image] = await captureBoard(key, {
          ratio: Math.min(1, PICTURE_WIDTH / board.width),
          maxHeight: board.frame,
        })
        if (image) {
          const url = URL.createObjectURL(blobOfDataUrl(image.data))
          const before = picturesRef.current[key]
          if (before) URL.revokeObjectURL(before.url)
          setPictures((all) => ({ ...all, [key]: { url, sha } }))
        }
      } catch {
        // No picture: the board stays live while it is in view.
      } finally {
        taking.current = false
        recheck((n) => n + 1)
      }
    }, 600)
    return () => clearTimeout(timer)
  })
  useEffect(
    () => () => {
      for (const p of Object.values(picturesRef.current)) URL.revokeObjectURL(p.url)
    },
    [],
  )

  const onFrame = useCallback((key: string, frame: HTMLIFrameElement | null) => {
    if (frame) frames.current.set(key, frame)
    else {
      frames.current.delete(key)
      setReady((all) => (all[key] ? { ...all, [key]: false } : all))
    }
  }, [])
  const overlay = useRef({ onOverlayMove, onOverlayClick })
  overlay.current = { onOverlayMove, onOverlayClick }
  const onBoardMove = useCallback(
    (e: React.MouseEvent, key: string) => overlay.current.onOverlayMove(e, key),
    [],
  )
  const onBoardClick = useCallback(
    (e: React.MouseEvent, key: string) => overlay.current.onOverlayClick(e, key),
    [],
  )
  const onBoardLeave = useCallback(
    (key: string) => setHover((h) => (h?.board === key ? null : h)),
    [],
  )
  const onDoubleClickRef = useRef(onDoubleClick)
  onDoubleClickRef.current = onDoubleClick
  const onBoardDoubleClick = useCallback((key: string) => {
    const last = selectionRef.current.at(-1)
    if (last?.board === key) onDoubleClickRef.current?.(last)
  }, [])
  const outline = (board: string, r: Rect | null | undefined) => {
    const b = layout.boards.find((x) => x.key === board)
    if (!b || !r) return null
    const s = screen(b.x + r.x, b.y + r.y)
    // Within its board: a page scrolled away from it shows nothing.
    const top = Math.max(s.top, screen(b.x, b.y).top)
    const bottom = Math.min(s.top + r.height * view.zoom, screen(b.x, b.y + b.frame).top)
    if (bottom <= top) return null
    return { left: s.left, top, width: r.width * view.zoom, height: bottom - top }
  }

  return (
    <div
      ref={box}
      tabIndex={0}
      data-keyboard
      aria-label="Design canvas"
      onKeyDown={onKey}
      onPointerDown={(e) => {
        // Drag on the canvas itself, or with the middle button anywhere: pan.
        const own =
          e.target === e.currentTarget || (e.target as HTMLElement).dataset.world !== undefined
        if (panning === 'space' || e.button === 1 || (own && e.button === 0)) {
          e.preventDefault()
          if (own && e.button === 0 && panning !== 'space' && selection.length) onSelect([])
          setPanning((p) => p ?? 'drag')
          startDrag(e)
        }
      }}
      className={cn(
        'relative min-h-0 flex-1 overflow-hidden bg-muted/40 outline-none select-none',
        panning ? 'cursor-grabbing' : 'cursor-default',
        className,
      )}
      style={{ touchAction: 'none' }}
    >
      <div
        data-world
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {layout.boards.map((b) => (
          <BoardView
            key={b.key}
            board={b}
            height={b.frame}
            live={live.has(b.key)}
            ready={Boolean(ready[b.key])}
            picture={pictures[b.key]?.url}
            reload={reloads[b.key] ?? 0}
            select={mode === 'select' && !panning && !(retyping && retyping.board === b.key)}
            onFrame={onFrame}
            onMove={onBoardMove}
            onLeave={onBoardLeave}
            onClick={onBoardClick}
            onDoubleClick={onBoardDoubleClick}
          />
        ))}
      </div>

      {/* Above the world, in screen pixels. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {layout.titles.map((t) => {
          const s = screen(t.x, t.y)
          return (
            <div
              key={t.key}
              className="absolute truncate text-base font-semibold text-foreground"
              style={{
                left: s.left,
                top: s.top - 48,
                maxWidth: Math.max(120, t.width * view.zoom),
              }}
            >
              {t.title}
            </div>
          )
        })}
        {layout.boards.map((b) => {
          const s = screen(b.x, b.y)
          return (
            <div
              key={b.key}
              className="absolute truncate text-xs text-muted-foreground"
              style={{ left: s.left, top: s.top - 20, maxWidth: Math.max(60, b.width * view.zoom) }}
            >
              {b.title ?? b.file}
              {scrolling[b.key] && ' · scrolls'}
            </div>
          )
        })}
        {mode === 'select' &&
          hover &&
          !selection.some((s) => s.board === hover.board && s.h === hover.element.h) && (
            <Outline box={outline(hover.board, hover.element.rect)} kind="hover" />
          )}
        {selection.map((s) => (
          <Outline
            key={selectedKey(s)}
            box={outline(s.board, rects[selectedKey(s)])}
            kind="selected"
          />
        ))}
      </div>

      {/* While panning, nothing below takes the pointer. */}
      {panning && <div className="absolute inset-0 cursor-grabbing" />}

      <div className="pointer-events-none absolute right-3 bottom-3 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground tabular-nums shadow-sm">
        {Math.round(view.zoom * 100)}%
      </div>
    </div>
  )
}

function Outline({
  box,
  kind,
}: {
  box: { left: number; top: number; width: number; height: number } | null
  kind: 'hover' | 'selected'
}) {
  if (!box) return null
  return (
    <div
      className={cn(
        'absolute rounded-[2px]',
        kind === 'selected' ? 'border-2 border-primary' : 'border border-primary/70',
      )}
      style={{ left: box.left - 1, top: box.top - 1, width: box.width + 2, height: box.height + 2 }}
    />
  )
}

/**
 * One board: its page in a frame while it is live, else the picture of it; the picture stays over
 * the frame until the page is ready. The clear layer over it takes the pointer in Select.
 */
const BoardView = memo(function BoardView({
  board,
  height,
  live,
  ready,
  picture,
  reload,
  select,
  onFrame,
  onMove,
  onLeave,
  onClick,
  onDoubleClick,
}: {
  board: CanvasBoard
  height: number
  live: boolean
  ready: boolean
  picture: string | undefined
  reload: number
  select: boolean
  onFrame: (key: string, frame: HTMLIFrameElement | null) => void
  onMove: (e: React.MouseEvent, board: string) => void
  onLeave: (board: string) => void
  onClick: (e: React.MouseEvent, board: string) => void
  onDoubleClick: (board: string) => void
}) {
  const key = board.key
  const frameRef = useCallback(
    (frame: HTMLIFrameElement | null) => onFrame(key, frame),
    [onFrame, key],
  )
  return (
    <div
      data-board={key}
      className="absolute bg-white shadow-sm ring-1 ring-black/10"
      style={{ left: board.x, top: board.y, width: board.width, height }}
    >
      {live && (
        <iframe
          key={`${board.src}#${reload}`}
          ref={frameRef}
          title={board.title ?? board.file}
          src={board.src}
          // Its own site already; the sandbox keeps it from the top window and from forms that navigate it.
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerPolicy="no-referrer"
          className="block size-full border-0"
        />
      )}
      {picture && !(live && ready) && (
        // eslint-disable-next-line @next/next/no-img-element -- a blob: URL made here
        <img
          src={picture}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full object-cover object-top"
        />
      )}
      {select && (
        <div
          data-board={key}
          className="absolute inset-0 cursor-default"
          onMouseMove={(e) => onMove(e, key)}
          onMouseLeave={() => onLeave(key)}
          onClick={(e) => onClick(e, key)}
          onDoubleClick={() => onDoubleClick(key)}
        />
      )}
    </div>
  )
})

export const DesignCanvas = DesignCanvasInner
