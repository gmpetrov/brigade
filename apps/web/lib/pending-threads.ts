'use client'
// Threads the dashboard opened before they exist: a box sends its message, and the thread opens
// at once under an id chosen here (POST /threads takes it), showing that message while the API
// starts it. Once it has, the thread's own conversation takes over; should it not, the thread
// says why and the message goes back to the box it came from.
import { useSyncExternalStore } from 'react'
import type { SentMessage } from '@/components/new-thread'
import type { Teammate } from '@/lib/api'
import { DEMO, DEMO_THREAD } from '@/lib/demo/flag'

export type PendingThread = {
  teammate: Teammate
  text: string
  /** Its files' names, as the message shows them. */
  files: string[]
  /** Where it was sent from, to go back to with the message. */
  from: string
  /** Why it did not start; unset while it starts. */
  error?: string
}

/** A message on its way back to the box it came from, after its thread did not start. */
export type ReturnedDraft = { from: string; message: SentMessage }

const pending = new Map<string, PendingThread>()
// As sent, with its files and where it was to run: what goes back to the box.
const messages = new Map<string, SentMessage>()
let returned: ReturnedDraft | undefined
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * A new thread's id, random, shaped as the API's own (a cuid: NewThreadId in contracts). In the
 * demo, marked as one the visitor started (lib/demo/install.ts).
 */
export function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  // 252 is the largest multiple of 36 under 256: bytes above it are drawn again, so each
  // character is as likely as another.
  for (let i = 0; i < bytes.length; i++)
    while (bytes[i]! >= 252) bytes[i] = crypto.getRandomValues(new Uint8Array(1))[0]!
  const id = `c${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
  return DEMO ? `${DEMO_THREAD}${id}` : id
}

export const pendingThreads = {
  add(id: string, thread: PendingThread, message: SentMessage) {
    pending.set(id, thread)
    messages.set(id, message)
    changed()
  },
  /** It started: its conversation shows from now on. */
  started(id: string) {
    pending.delete(id)
    messages.delete(id)
    changed()
  },
  failed(id: string, error: string) {
    const thread = pending.get(id)
    if (!thread) return
    pending.set(id, { ...thread, error })
    changed()
  },
  /** Gives up on it: its message and files go back to the box it was sent from. */
  giveBack(id: string) {
    const thread = pending.get(id)
    if (!thread) return
    const message = messages.get(id)
    if (!message) return
    returned = { from: thread.from, message }
    // It stays as it is until the page has gone: its conversation would ask for a thread that
    // never started.
    messages.delete(id)
    return thread.from
  },
  /** The message given back for the box at this address, once. */
  takeReturned(from: string) {
    if (returned?.from !== from) return undefined
    const draft = returned
    returned = undefined
    return draft
  },
}

/** The thread with this id, while it is pending. */
export function usePendingThread(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribe,
    () => (id ? pending.get(id) : undefined),
    () => undefined,
  )
}
