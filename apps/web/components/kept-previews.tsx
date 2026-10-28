'use client'
// A thread's preview, kept while the person is on another thread: its frame stays in the
// page, hidden, so coming back finds the app as it was left (the page, what was typed,
// where it was scrolled), not loaded again. A browser loads a frame again whenever it
// leaves the page, so the panels are rendered here, by the dashboard, rather than by the
// thread's conversation, which goes when the thread does: the conversation hands its
// panel's props over (KeepPreview) and the dashboard renders them (KeptPreviews).
// The latest few hidden ones are kept, since each still runs its app in this tab; one
// closed, or replaced by a file beside its thread, goes.
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { PreviewPanel } from '@/components/preview-panel'

type PanelProps = Omit<Parameters<typeof PreviewPanel>[0], 'hidden'>
/** `seen`: when it last showed, for which hidden ones go first. */
type Kept = { threadId: string; props: PanelProps; shown: boolean; seen: number }

/** Hidden ones kept at most: the latest left. */
const MAX_HIDDEN = 3

// In the order they came, never moved: a frame moved in the page loads again too. Which
// one is in front is the panels' stack (components/side-panel.tsx), not this order.
let kept: Kept[] = []
let clock = 0
const listeners = new Set<() => void>()
function set(next: Kept[]) {
  kept = next
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const NONE: Kept[] = []

function show(threadId: string, props: PanelProps, shown: boolean) {
  const was = kept.find((k) => k.threadId === threadId)
  // Its thread open, shown or not: the latest, so never the one to go.
  const entry = { threadId, props, shown, seen: ++clock }
  set(was ? kept.map((k) => (k === was ? entry : k)) : [...kept, entry])
  if (!shown) trim()
}

function hide(threadId: string) {
  if (!kept.some((k) => k.threadId === threadId && k.shown)) return
  set(kept.map((k) => (k.threadId === threadId ? { ...k, shown: false, seen: ++clock } : k)))
  trim()
}

/** The hidden ones over MAX_HIDDEN go, those shown longest ago first. */
function trim() {
  const hidden = kept.filter((k) => !k.shown).sort((a, b) => a.seen - b.seen)
  const over = new Set(hidden.slice(0, Math.max(0, hidden.length - MAX_HIDDEN)))
  if (over.size) set(kept.filter((k) => !over.has(k)))
}

/** The thread's preview, no longer kept: closed, or something else beside the thread. */
export function dropKeptPreview(threadId: string) {
  if (kept.some((k) => k.threadId === threadId)) set(kept.filter((k) => k.threadId !== threadId))
}

/**
 * In the conversation, where its preview panel would be: hands the panel over to the
 * dashboard, shown or hidden; going (the thread left), the panel stays, hidden.
 */
export function KeepPreview({ threadId, shown, ...props }: PanelProps & { shown: boolean }) {
  // Each render: its callbacks and the preview as it stands. Before the browser paints, so
  // the page makes room for it in the same frame (and the thread's pill slides across).
  useLayoutEffect(() => show(threadId, props as PanelProps, shown))
  useLayoutEffect(() => () => hide(threadId), [threadId])
  return null
}

/** Whether a kept preview shows: changes as one opens or closes beside the page. */
export function useKeptPreviewShown() {
  return useSyncExternalStore(
    subscribe,
    () => kept.some((k) => k.shown),
    () => false,
  )
}

/** The panels, rendered once by the dashboard: the one shown, and those kept hidden. */
export function KeptPreviews() {
  const list = useSyncExternalStore(
    subscribe,
    () => kept,
    () => NONE,
  )
  return list.map(({ threadId, props, shown }) => (
    <PreviewPanel key={threadId} {...props} hidden={!shown} />
  ))
}
