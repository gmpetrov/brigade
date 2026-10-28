'use client'
// The asks of a ticket answered so far, kept in this browser until the whole
// ticket is sent: leaving the page or reloading it loses none of them, in the
// thread as on Home. Nothing reaches the API before then, so an access is
// granted only as the ticket is answered (apps/api/src/decide.ts).
import { useCallback, useEffect, useState } from 'react'
import type { Ask, AskReply } from '@brigade/contracts'

const KEY = 'brigade.tickets.replies'
/** Answers left on a ticket that was never sent are dropped after this long. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

type Replies = Record<string, AskReply>
type Saved = Record<string, { replies: Replies; at: number }>

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? (saved as Saved) : {}
  } catch {
    return {}
  }
}

/** The ticket's saved replies, for asks it still has. */
function savedFor(requestId: string, asks: Ask[]): Replies {
  const replies = load()[requestId]?.replies ?? {}
  return Object.fromEntries(
    asks.flatMap((a) => (replies[a.id]?.type === a.type ? [[a.id, replies[a.id]!]] : [])),
  )
}

/**
 * Every ticket's replies saved here, by ticket: a hand back sends them, so it can answer
 * the ticket it ends with the asks already answered (apps/api/src/routes/threads.ts).
 */
export function savedReplies(): Record<string, Replies> {
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(load()).flatMap(([id, s]) =>
      now - s.at < KEEP_MS && s.replies ? [[id, s.replies]] : [],
    ),
  )
}

function save(requestId: string, replies: Replies | undefined) {
  try {
    const now = Date.now()
    const all = Object.fromEntries(
      Object.entries(load()).filter(([id, s]) => id !== requestId && now - s.at < KEEP_MS),
    )
    if (replies && Object.keys(replies).length) all[requestId] = { replies, at: now }
    if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all))
    else localStorage.removeItem(KEY)
  } catch {}
}

/**
 * The replies given so far on the ticket `requestId`, kept until it is sent:
 * `forget` once it is (or answered elsewhere, `answered`). Another tab
 * answering the same ticket shows here too.
 */
export function useTicketReplies(requestId: string, asks: Ask[], answered: boolean) {
  const [replies, setReplies] = useState<Replies>(() => (answered ? {} : savedFor(requestId, asks)))

  useEffect(() => {
    if (answered) {
      save(requestId, undefined)
      return
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) setReplies(savedFor(requestId, asks))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [requestId, asks, answered])

  const keep = useCallback(
    (next: Replies) => {
      setReplies(next)
      save(requestId, next)
    },
    [requestId],
  )
  const forget = useCallback(() => save(requestId, undefined), [requestId])
  return [replies, keep, forget] as const
}
