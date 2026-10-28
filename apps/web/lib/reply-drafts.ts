'use client'
// Replies being written, per thread: closing the panel or opening another thread
// keeps them. Other places add to one (a document's Ask, with the file and a
// passage), and the thread shows it in its box, focused, whether open already or next.
import { useEffect, useState } from 'react'

const drafts = new Map<string, string>()
const listeners = new Set<(threadId: string) => void>()
/** Threads with text added while they were not open: their box takes the cursor as it opens. */
const pendingFocus = new Set<string>()

/** Adds `text` on a line of its own after what the thread's reply holds. */
export function addToReply(threadId: string, text: string) {
  const current = (drafts.get(threadId) ?? '').trimEnd()
  drafts.set(threadId, current ? `${current}\n${text}` : text)
  pendingFocus.add(threadId)
  for (const listener of listeners) listener(threadId)
}

/** What the thread's reply holds now, e.g. to leave out what it has already. */
export const replyDraft = (threadId: string) => drafts.get(threadId) ?? ''

/** The reply being written in a thread; `onAdded` when text is added to it from elsewhere. */
export function useReplyDraft(id: string, onAdded?: () => void) {
  const [text, setText] = useState(() => drafts.get(id) ?? '')
  useEffect(() => {
    if (text) drafts.set(id, text)
    else drafts.delete(id)
  }, [id, text])
  useEffect(() => {
    const take = (threadId: string) => {
      if (threadId !== id || !pendingFocus.delete(id)) return
      setText(drafts.get(id) ?? '')
      onAdded?.()
    }
    // Added just before this thread opened.
    take(id)
    listeners.add(take)
    return () => {
      listeners.delete(take)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callback as it was first given
  }, [id])
  return [text, setText] as const
}
