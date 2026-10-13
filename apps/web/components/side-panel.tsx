'use client'
// The panel beside a page: a document, a file a thread mentions, a teammate's
// computer. Fixed to the right on wide screens (the page makes room for it,
// see globals.css), a sheet from the bottom on narrow ones. Its width is one
// --desktop-w for all of them: drag the left edge to change it, double-click
// to reset; remembered in this browser. Escape closes it. Panels open together
// share the right edge: the last one opened, or brought forward, is on top.
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'

const WIDTH_KEY = 'brigade:panel-width'
/** Narrowest panel, and the least the page beside it keeps. */
const MIN_PANEL = 360
const MIN_PAGE = 420

function maxWidth() {
  const page = document.querySelector('[data-slot="sidebar-inset"]')?.getBoundingClientRect()
  return Math.max(MIN_PANEL, (page?.width ?? window.innerWidth) - MIN_PAGE)
}

function setWidth(px: number | null) {
  const root = document.documentElement.style
  if (px === null) {
    root.removeProperty('--desktop-w')
    try {
      localStorage.removeItem(WIDTH_KEY)
    } catch {}
    return
  }
  const width = Math.round(Math.min(maxWidth(), Math.max(MIN_PANEL, px)))
  root.setProperty('--desktop-w', `${width}px`)
  try {
    localStorage.setItem(WIDTH_KEY, String(width))
  } catch {}
}

/** The width chosen earlier in this browser, if any. */
function useSavedWidth() {
  useEffect(() => {
    let saved: number | undefined
    try {
      saved = Number(localStorage.getItem(WIDTH_KEY)) || undefined
    } catch {}
    if (saved) setWidth(saved)
  }, [])
}

/**
 * The panel's left edge: drag to resize, arrow keys too, double-click to
 * reset. Inside a positioned panel, on wide screens only.
 */
export function PanelResizeHandle() {
  useSavedWidth()
  const panel = useRef<HTMLDivElement>(null)

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('select-none', 'cursor-col-resize')
    const move = (m: PointerEvent) => setWidth(window.innerWidth - m.clientX)
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('select-none', 'cursor-col-resize')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const current = panel.current?.parentElement?.getBoundingClientRect().width ?? MIN_PANEL
    setWidth(current + (e.key === 'ArrowLeft' ? 32 : -32))
  }

  return (
    <div
      ref={panel}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(null)}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-1.5 z-20 hidden w-3 cursor-col-resize touch-none outline-none xl:block"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary group-active:bg-primary"
      />
    </div>
  )
}

/** The panels beside the page, bottom to top. */
let stack: string[] = []
const listeners = new Set<() => void>()
function setStack(next: string[]) {
  stack = next
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const readStack = () => stack
const NO_PANELS: string[] = []

/** Brings an open panel in front of the others; opening one already does. */
export function raisePanel(name: string) {
  if (stack.includes(name) && stack.at(-1) !== name)
    setStack([...stack.filter((p) => p !== name), name])
}

/** Whether the panel is open and on top. */
export function panelInFront(name: string) {
  return stack.at(-1) === name
}

/** The same, kept up to date. */
export function usePanelInFront(name: string) {
  return useSyncExternalStore(subscribe, readStack, () => NO_PANELS).at(-1) === name
}

/**
 * A panel's place in the stack while it is open (`stacked`): its z-index, from
 * --panel-z beside the page and --sheet-z as a sheet on narrow screens, and
 * whether it is on top. It comes in front as it opens, and each time `raiseKey`
 * changes.
 */
export function usePanelStack(stacked = true, name?: string, raiseKey?: unknown) {
  const generated = useId()
  const id = name ?? generated
  useEffect(() => {
    if (!stacked) return
    setStack([...stack.filter((p) => p !== id), id])
    return () => setStack(stack.filter((p) => p !== id))
  }, [stacked, id])
  useEffect(() => {
    if (stacked) raisePanel(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raiseKey])
  const order = useSyncExternalStore(subscribe, readStack, () => NO_PANELS)
  const rank = Math.min(Math.max(order.indexOf(id), 0), 8)
  return {
    front: stacked && order.at(-1) === id,
    style: { '--panel-z': 10 + rank, '--sheet-z': 40 + rank } as CSSProperties,
  }
}

/** Menus, popovers and dialogs that take Escape first: the editor's, the dashboard's. */
const OPEN_LAYER =
  '.bn-suggestion-menu, .bn-grid-suggestion-menu, .bn-panel, .bn-menu-dropdown, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

const editable = (el: Element) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLElement && el.isContentEditable)

/**
 * Escape closes the panel, unless something open takes it (a menu in the
 * editor, a dialog), the person is typing elsewhere on the page, or what has
 * focus takes every key itself (`data-keyboard`: a remote desktop, a terminal).
 */
export function useEscapeToClose(
  panel: RefObject<HTMLElement | null>,
  onClose?: () => void,
  /**
   * Last in line: only once no panel took it (they go first), and never while typing,
   * in it or not. For a view whose Escape leaves it, not one that closes beside a page.
   */
  last = false,
) {
  useEffect(() => {
    if (!onClose) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      if (document.querySelector(OPEN_LAYER)) return
      const focus = document.activeElement
      if (focus && (last || !panel.current?.contains(focus)) && editable(focus)) return
      if (focus?.closest('[data-keyboard]')) return
      // Before the editor's own Escape, which only takes focus out of it.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Panels listen as the key goes down to the page; the last one as it comes back up.
    window.addEventListener('keydown', onKeyDown, !last)
    return () => window.removeEventListener('keydown', onKeyDown, !last)
  }, [panel, onClose, last])
}

/**
 * A panel beside the page. Put a header row and a scrolling body inside.
 * Expanded, the same panel takes the page's place instead: in the page's flow,
 * its full width and the window's height, with nothing beside it to resize.
 */
export function SidePanel({
  className,
  children,
  onClose,
  expanded = false,
  name,
  raiseKey,
  style,
  ...props
}: ComponentProps<'aside'> & {
  children: ReactNode
  /** Escape calls it, while it is on top. */
  onClose?: () => void
  expanded?: boolean
  /** For raisePanel. */
  name?: string
  /** Changes each time what it shows does: it comes in front again. */
  raiseKey?: unknown
}) {
  const panel = useRef<HTMLElement>(null)
  const stack = usePanelStack(!expanded, name, raiseKey)
  useEscapeToClose(panel, stack.front ? onClose : undefined)
  return (
    <aside
      ref={panel}
      data-desktop-panel={expanded ? undefined : ''}
      data-expanded={expanded || undefined}
      className={cn(
        expanded
          ? 'relative flex h-svh min-w-0 flex-col overflow-hidden bg-background'
          : [
              'fixed inset-x-0 bottom-0 z-(--sheet-z) flex h-[70vh] flex-col overflow-hidden rounded-t-xl border-t bg-card shadow-lg',
              'xl:inset-y-0 xl:right-0 xl:left-auto xl:z-(--panel-z) xl:h-auto xl:w-(--desktop-w) xl:overflow-visible xl:rounded-none xl:border-t-0 xl:border-l xl:shadow-none',
            ],
        className,
      )}
      style={expanded ? style : { ...stack.style, ...style }}
      {...props}
    >
      {!expanded && <PanelResizeHandle />}
      {children}
    </aside>
  )
}
