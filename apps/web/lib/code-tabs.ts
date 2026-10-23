// The code panel beside a thread's preview: whether it shows, the files open in it as
// tabs and the one in front, and whether its tree shows. Per thread, outside the
// panels (the preview's panel unmounts when a file or document takes its place),
// and kept for the browser tab's session, so a reload opens the same files.
import { useCallback, useSyncExternalStore } from 'react'

export type CodeTab = {
  /** Whose working folder it is in: the copy the preview ran when it was opened. */
  teammateId: string
  /** Relative to that folder. */
  path: string
  /** The line to show, and a count that changes each time it is asked for again. */
  line?: number
  nonce: number
}

export type CodePanelState = {
  open: boolean
  tabs: CodeTab[]
  /** tabKey of the tab in front. */
  active?: string
  tree: boolean
}

export const tabKey = (tab: Pick<CodeTab, 'teammateId' | 'path'>) =>
  `${tab.teammateId}\u0000${tab.path}`

const CLOSED: CodePanelState = { open: false, tabs: [], tree: true }
const states = new Map<string, CodePanelState>()
const listeners = new Set<() => void>()
const storageKey = (threadId: string) => `brigade:code:${threadId}`

function read(threadId: string): CodePanelState {
  const known = states.get(threadId)
  if (known) return known
  let state = CLOSED
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(storageKey(threadId)) ?? 'null',
    ) as CodePanelState | null
    if (saved && Array.isArray(saved.tabs)) state = { ...CLOSED, ...saved }
  } catch {
    // Nothing saved, or no storage: closed.
  }
  states.set(threadId, state)
  return state
}

function write(threadId: string, change: (state: CodePanelState) => CodePanelState) {
  const next = change(read(threadId))
  states.set(threadId, next)
  try {
    sessionStorage.setItem(storageKey(threadId), JSON.stringify(next))
  } catch {
    // Full or blocked: kept for this page only.
  }
  for (const listener of listeners) listener()
}

/** Opens a file in a tab, in front, at a line; the panel shows. */
export function openCodeTab(
  threadId: string,
  file: { teammateId: string; path: string; line?: number },
) {
  write(threadId, (state) => {
    const key = tabKey(file)
    const nonce = Date.now()
    const tab = { ...file, nonce }
    const tabs = state.tabs.some((t) => tabKey(t) === key)
      ? state.tabs.map((t) => (tabKey(t) === key ? tab : t))
      : [...state.tabs, tab]
    return { ...state, open: true, tabs, active: key }
  })
}

/** Closes a tab; the one beside it comes in front. */
export function closeCodeTab(threadId: string, key: string) {
  write(threadId, (state) => {
    const at = state.tabs.findIndex((t) => tabKey(t) === key)
    if (at < 0) return state
    const tabs = state.tabs.filter((_, i) => i !== at)
    const next = tabs[Math.min(at, tabs.length - 1)]
    return { ...state, tabs, active: state.active === key ? next && tabKey(next) : state.active }
  })
}

export const setCodePanel = (threadId: string, change: Partial<CodePanelState>) =>
  write(threadId, (state) => ({ ...state, ...change }))

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCodePanel(threadId: string) {
  const get = useCallback(() => read(threadId), [threadId])
  return useSyncExternalStore(subscribe, get, () => CLOSED)
}
