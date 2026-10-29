'use client'
// Threads the dashboard opened before they exist: a box sends its message, and the thread opens
// at once under an id chosen here (POST /threads takes it), showing that message while the API
// starts it. Once it has, the thread's own conversation takes over; should it not, the thread
// says why and the message goes back to the box it came from.
import { useSyncExternalStore } from 'react'
import type { Upload } from '@/components/attachments'
import type { SentMessage } from '@/components/new-thread'
import type { Teammate } from '@/lib/api'
import { DEMO, DEMO_THREAD } from '@/lib/demo/flag'

export type PendingThread = {
  teammate: Teammate
  text: string
  /** Its files, shown from this browser's copies until its conversation shows them. */
  files: Pick<Upload, 'key' | 'name' | 'size' | 'preview' | 'media'>[]
  /** Where it was sent from, to go back to with the message. */
  from: string
  /**
   * Where the message goes should it not start: back to the page's own box (`box`: Home, a
   * project's), or aside, for the new-thread dialog to take up (`dialog`: a box gone with its
   * dialog, or one sharing its draft with the dialog's).
   */
  giveBack: 'box' | 'dialog'
  /** Why it did not start; unset while it starts. */
  error?: string
}

/** A message on its way back to the box it came from, after its thread did not start. */
export type ReturnedDraft = { from: string; message: SentMessage }

/** A message kept aside: one whose thread did not start, or one swapped out of the box for it. */
export type KeptMessage = SentMessage & { key: string; error?: string }

const pending = new Map<string, PendingThread>()
// Started, their conversation showing: the message sent, until its runner has it in the thread.
const opened = new Map<string, PendingThread>()
// As sent, with its files and where it was to run: what goes back to the box.
const messages = new Map<string, SentMessage>()
let returned: ReturnedDraft | undefined
// Newest last. Kept until taken up or dismissed: never put in a box that may hold another.
let kept: KeptMessage[] = []
let takeUp: ((message: KeptMessage) => void) | undefined
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
  /** It started: its conversation shows from now on, with the message until it has it. */
  started(id: string) {
    const thread = pending.get(id)
    if (thread) opened.set(id, thread)
    pending.delete(id)
    messages.delete(id)
    changed()
  },
  /** Its conversation has the message: this browser's copy, and its files' previews, can go. */
  delivered(id: string) {
    const thread = opened.get(id)
    if (!thread) return
    opened.delete(id)
    for (const f of thread.files) if (f.preview) URL.revokeObjectURL(f.preview)
    changed()
  },
  failed(id: string, error: string) {
    const thread = pending.get(id)
    if (!thread) return
    pending.set(id, { ...thread, error })
    const message = messages.get(id)
    if (thread.giveBack === 'dialog' && message) {
      messages.delete(id)
      keptMessages.keep({ ...message, key: id, error })
    }
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

/** The message a thread opened at once was started with, until its conversation has it. */
export function useOpenedMessage(id: string) {
  return useSyncExternalStore(
    subscribe,
    () => opened.get(id),
    () => undefined,
  )
}

/** The thread with this id, while it is pending. */
export function usePendingThread(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribe,
    () => (id ? pending.get(id) : undefined),
    () => undefined,
  )
}

/** Messages kept aside, which the new-thread dialog (components/quick-thread.tsx) takes up. */
export const keptMessages = {
  keep(message: KeptMessage) {
    kept = [...kept.filter((m) => m.key !== message.key), message]
    changed()
  },
  drop(key: string) {
    kept = kept.filter((m) => m.key !== key)
    changed()
  },
  /** Into the new-thread dialog's box, which opens with it (what it held is kept aside). */
  takeUp(key: string) {
    const message = kept.find((m) => m.key === key)
    if (message && takeUp) takeUp(message)
  },
  /** The dialog, which takes them up: one at a time. */
  handle(handler: (message: KeptMessage) => void) {
    takeUp = handler
    return () => {
      if (takeUp === handler) takeUp = undefined
    }
  },
}

/** The messages kept aside, newest last. */
export function useKeptMessages() {
  return useSyncExternalStore(
    subscribe,
    () => kept,
    () => kept,
  )
}
