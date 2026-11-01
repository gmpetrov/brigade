// Edits a person stacks before sending them to a thread in one message: comments on
// a design's canvas beside the thread (here), and elements picked in its preview (the
// thread's composer keeps those, with their pictures). The composer shows both as one
// numbered list, "Pending edits"; its send button sends them with what is written.
// Kept per thread while the dashboard is open, like the composer's text and files.
import { useSyncExternalStore } from 'react'

export type EditRect = { x: number; y: number; width: number; height: number }

/** A comment on a design, waiting in the thread's composer. */
export type DesignEdit = {
  id: string
  /** When it was added: the list goes in that order, with the preview's elements. */
  at: number
  /** The design it is on (its library folder). */
  folder: string
  /** The board it is on, by its key on the canvas, and where the element was on it. */
  board: string | null
  rect: EditRect | null
  /** What its row names: the element, else the board or the design. */
  label: string
  /** Where it is, for the teammate: "Comment on the design … on the board …, on `cta`:". */
  where: string
  /** What should change. */
  note: string
}

/** The thread's composer: how many edits wait there, and its send, for the canvas over it. */
export type EditsSender = {
  count: number
  /** The keys of all its edits in their order, the preview's elements included: their numbers. */
  order: string[]
  send: () => void
  disabled?: string
}

const edits = new Map<string, DesignEdit[]>()
const senders = new Map<string, EditsSender>()
const listeners = new Set<() => void>()
const NONE: DesignEdit[] = []

function changed() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function designEditsOf(threadId: string): DesignEdit[] {
  return edits.get(threadId) ?? NONE
}

export function setDesignEdits(threadId: string, list: DesignEdit[]) {
  if (list.length) edits.set(threadId, list)
  else edits.delete(threadId)
  changed()
}

export function addDesignEdit(threadId: string, edit: Omit<DesignEdit, 'id' | 'at'>) {
  const at = Date.now()
  setDesignEdits(threadId, [
    ...designEditsOf(threadId),
    { ...edit, id: `${at}-${Math.random().toString(36).slice(2, 8)}`, at },
  ])
}

export function updateDesignEdit(threadId: string, id: string, note: string) {
  setDesignEdits(
    threadId,
    designEditsOf(threadId).map((e) => (e.id === id ? { ...e, note } : e)),
  )
}

export function removeDesignEdit(threadId: string, id: string) {
  setDesignEdits(
    threadId,
    designEditsOf(threadId).filter((e) => e.id !== id),
  )
}

/** The design edits waiting in a thread's composer. */
export function useDesignEdits(threadId: string | undefined): DesignEdit[] {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? designEditsOf(threadId) : NONE),
    () => NONE,
  )
}

/** The composer says how many edits wait and how to send them; undefined when it goes. */
export function setEditsSender(threadId: string, sender: EditsSender | undefined) {
  const last = senders.get(threadId)
  if (
    last === sender ||
    (last &&
      sender &&
      last.count === sender.count &&
      last.order.join('\n') === sender.order.join('\n') &&
      last.send === sender.send &&
      last.disabled === sender.disabled)
  )
    return
  if (sender) senders.set(threadId, sender)
  else senders.delete(threadId)
  changed()
}

export function useEditsSender(threadId: string | undefined): EditsSender | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? senders.get(threadId) : undefined),
    () => undefined,
  )
}

/** A design edit as the message carries it. */
export const designEditText = (edit: DesignEdit) => `${edit.where}\n\n${edit.note.trim()}`
