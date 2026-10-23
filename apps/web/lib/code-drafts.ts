// Unsaved edits of files in teammates' working folders, by thread, teammate and path.
// Kept outside the panels, which unmount when another file, the preview or a document
// takes their place: the file opens again with them, and its tab shows a dot. Leaving
// or reloading the page while any is left asks first.
import { useSyncExternalStore } from 'react'

export type CodeDraft = {
  text: string
  /** The hash of the file the edits started from, which a save expects to find. */
  base?: string
}

const drafts = new Map<string, CodeDraft>()
const listeners = new Set<() => void>()
/** A new object at each change of which files have a draft, for useSyncExternalStore. */
let keys: ReadonlySet<string> = new Set()

export const draftKey = (threadId: string, teammateId: string, path: string) =>
  JSON.stringify([threadId, teammateId, path])

export const getDraft = (key: string) => drafts.get(key)

export function setDraft(key: string, draft: CodeDraft | undefined) {
  const had = drafts.has(key)
  if (draft) drafts.set(key, draft)
  else drafts.delete(key)
  if (had === !!draft) return
  keys = new Set(drafts.keys())
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const empty: ReadonlySet<string> = new Set()

/** The keys of files with unsaved edits, for dots on tabs. */
export const useDraftKeys = () =>
  useSyncExternalStore(
    subscribe,
    () => keys,
    () => empty,
  )

if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (drafts.size) e.preventDefault()
  })
