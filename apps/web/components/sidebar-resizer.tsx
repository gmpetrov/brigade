'use client'
// The sidebar's right edge: dragged, it sets the sidebar's width between MIN and MAX;
// dragged past COLLAPSE_AT it folds to the rail of icons, and dragged out of the rail it
// opens again. Double-click goes back to the default width. The width is kept in this
// browser; folded or not stays in the sidebar's own cookie.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useSidebar } from '@/components/ui/sidebar'
import { Hint } from '@/components/ui/tooltip'

const KEY = 'brigade:sidebar-width'
export const SIDEBAR_DEFAULT = 288
const MIN = 224
const MAX = 420
/** Narrower than this while dragging, it folds. */
const COLLAPSE_AT = 160
/** Folded, dragged out past this, it opens. Past COLLAPSE_AT, so that a pointer held
 *  between the two leaves it as it is instead of folding and opening on every move. */
const EXPAND_AT = 200
const clamp = (width: number) => Math.round(Math.min(MAX, Math.max(MIN, width)))

/** The width, as it was left in this browser. */
export function useSidebarWidth() {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT)
  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY))
    if (saved) setWidth(clamp(saved))
  }, [])
  const set = useCallback((next: number) => {
    const value = clamp(next)
    setWidth(value)
    try {
      localStorage.setItem(KEY, String(value))
    } catch {}
  }, [])
  return [width, set] as const
}

export function SidebarResizer({
  width,
  onWidth,
}: {
  width: number
  onWidth: (width: number) => void
}) {
  const { open, setOpen, isMobile } = useSidebar()
  // The drag reads the latest, not the one it started with: it may fold and open again.
  const openNow = useRef(open)
  openNow.current = open
  const [dragging, setDragging] = useState(false)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    // No animation while it follows the pointer, and no text selected on the way.
    document.documentElement.dataset.sidebarResizing = ''
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return
    // The sidebar is on the left, from the window's edge.
    const x = e.clientX
    if (openNow.current) {
      if (x < COLLAPSE_AT) setOpen(false)
      else onWidth(x)
    } else if (x > EXPAND_AT) {
      setOpen(true)
      onWidth(x)
    }
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    delete document.documentElement.dataset.sidebarResizing
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (!open) return
      if (width - step < MIN) setOpen(false)
      else onWidth(width - step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (!open) setOpen(true)
      else onWidth(width + step)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      setOpen(!open)
    }
  }

  if (isMobile) return null
  return (
    <Hint side="right" label="Drag to resize, double-click for the default width">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={open ? width : 0}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          if (!open) setOpen(true)
          onWidth(SIDEBAR_DEFAULT)
        }}
        onKeyDown={onKeyDown}
        data-dragging={dragging || undefined}
        className="group/resizer absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none outline-none"
      >
        <span
          aria-hidden
          className="bg-primary absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 opacity-0 transition-opacity group-hover/resizer:opacity-60 group-focus-visible/resizer:opacity-100 group-data-[dragging]/resizer:opacity-100"
        />
      </div>
    </Hint>
  )
}
