'use client'
// Messages sent from a thread that the thread has not shown yet, per thread, outside the
// thread's view: one the API refused stays, with what it carried, when another thread opens
// and this one opens again, as a reply being written does (lib/reply-drafts.ts).
import { useCallback, useSyncExternalStore } from 'react'
import type { Outgoing } from '@/components/queued-messages'

const NONE: Outgoing[] = []
const lists = new Map<string, Outgoing[]>()
const listeners = new Map<string, Set<() => void>>()

/** A thread's messages on their way, as they are now. */
export const outgoingOf = (threadId: string) => lists.get(threadId) ?? NONE

/** Change a thread's messages on their way: from its view, or from a send that outlived it. */
export function updateOutgoing(threadId: string, update: (list: Outgoing[]) => Outgoing[]) {
  const next = update(lists.get(threadId) ?? NONE)
  if (next.length) lists.set(threadId, next)
  else lists.delete(threadId)
  for (const listener of listeners.get(threadId) ?? []) listener()
}

/** A thread's messages on their way, and their setter. */
export function useOutgoing(threadId: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(threadId) ?? new Set()
      set.add(listener)
      listeners.set(threadId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(threadId)
      }
    },
    [threadId],
  )
  const list = useSyncExternalStore(
    subscribe,
    () => outgoingOf(threadId),
    () => NONE,
  )
  const set = useCallback(
    (update: (list: Outgoing[]) => Outgoing[]) => updateOutgoing(threadId, update),
    [threadId],
  )
  return [list, set] as const
}
