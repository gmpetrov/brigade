'use client'
// The documents open to edit, apart from what shows them. A document opens (its session from
// POST /library/edit, then its room over a socket, which syncs it) as soon as someone is
// about to show it (prepareDocument, lib/prepare-document.ts), and stays open a while after its
// panel closed: shown then, or again, it appears at once, with no request, socket or sync to
// wait for. One connection per document, however many show it.
import type { EditSession, EditTarget } from '@brigade/contracts'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import YProvider from 'y-partyserver/provider'
import * as Y from 'yjs'
import { api } from '@/lib/api'
import { setOpener, takeAskedSession } from '@/lib/prepare-document'

/** `id`: this connection, as its editor's key (a document closed and opened again has another). */
export type LiveConnection = { id: number; doc: Y.Doc; provider: YProvider }

export type LiveSession = {
  session?: EditSession
  error?: string
  /** Synced through the collab server (`session.live`). */
  connection?: LiveConnection
  /**
   * Shown, not yet editable: the room opened on what it had (`early`) and still checks it
   * against the stored text (apps/collab). A change it finds can replace a whole block, with
   * what was typed in it.
   */
  held: boolean
  /** Deleted while open: its room closed the connection. */
  deleted?: boolean
}

/** Kept this long once nothing shows it: shown again meanwhile, it is there at once. */
const KEEP_MS = 5 * 60_000
/** Prepared (a pointer resting on it, say) but never shown: kept this long. */
const PREPARED_MS = 60_000
/** At most this many kept that nothing shows; the one used longest ago goes first. */
const MAX_KEPT = 6

type Entry = {
  key: string
  target: EditTarget
  state: LiveSession
  /** What shows it now. */
  users: number
  /** Shown at least once: kept longer than one only prepared. */
  shown: boolean
  usedAt: number
  timer?: ReturnType<typeof setTimeout>
  closed: boolean
}

const EMPTY: LiveSession = { held: false }
let connections = 0
const entries = new Map<string, Entry>()
/** By document: an entry closed and opened again keeps who listens. */
const listeners = new Map<string, Set<() => void>>()

export const keyOf = (target: EditTarget) => JSON.stringify(target)

export const openDocument = (target: EditTarget) =>
  api<EditSession>('/library/edit', { body: target })

function update(entry: Entry, patch: Partial<LiveSession>) {
  entry.state = { ...entry.state, ...patch }
  if (entries.get(entry.key) !== entry) return
  for (const listener of listeners.get(entry.key) ?? []) listener()
}

function start(target: EditTarget) {
  const entry: Entry = {
    key: keyOf(target),
    target,
    state: EMPTY,
    users: 0,
    shown: false,
    usedAt: Date.now(),
    closed: false,
  }
  entries.set(entry.key, entry)
  // Asked for already when it was prepared before this code was in.
  ;(takeAskedSession(target) ?? openDocument(target)).then(
    (session) => {
      if (entry.closed) return
      update(entry, { session })
      if (session.live) connect(entry, session.live)
      // Edited alone and saved whole (no collab server): kept, its text would go stale.
      else if (!entry.users) close(entry)
    },
    (error: Error) => {
      if (entry.closed) return
      update(entry, { error: error.message })
      // Shown again, it asks again.
      if (!entry.users) close(entry)
    },
  )
  return entry
}

function connect(entry: Entry, live: NonNullable<EditSession['live']>) {
  const doc = new Y.Doc()
  const url = new URL(live.url)
  // The first connection uses the token that came with the session; reconnects ask for a new one.
  let token: string | undefined = live.token
  const provider = new YProvider(url.host, live.room, doc, {
    party: live.party,
    protocol: url.protocol === 'https:' ? 'wss' : 'ws',
    params: async () => {
      const fresh = token ?? (await openDocument(entry.target).catch(() => null))?.live?.token
      token = undefined
      // The room shows what it has at once, and says when edits may go ahead (apps/collab).
      return { token: fresh ?? '', early: '1' }
    },
  })
  // Listening from the start: the room says `checking` before anything else.
  let checked = false
  provider.on('custom-message', (message: string) => {
    let notice: { type?: string }
    try {
      notice = JSON.parse(message) as typeof notice
    } catch {
      return
    }
    // Once only: after a reconnect, what was typed meanwhile is the person's, as before.
    if (notice.type === 'checking' && !checked) update(entry, { held: true })
    if (notice.type === 'checked') {
      checked = true
      update(entry, { held: false })
    }
  })
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event?.code !== 4404) return
    provider.disconnect()
    update(entry, { deleted: true })
    if (!entry.users) close(entry)
  })
  update(entry, { connection: { id: ++connections, doc, provider } })
}

function close(entry: Entry) {
  if (entry.closed) return
  entry.closed = true
  clearTimeout(entry.timer)
  if (entries.get(entry.key) === entry) entries.delete(entry.key)
  const connection = entry.state.connection
  if (connection) {
    connection.provider.destroy()
    connection.doc.destroy()
  }
}

/** Closes it once unused for a while, and the oldest unused past MAX_KEPT. */
function schedule(entry: Entry) {
  clearTimeout(entry.timer)
  if (entry.users > 0) return
  entry.timer = setTimeout(() => close(entry), entry.shown ? KEEP_MS : PREPARED_MS)
  const unused = [...entries.values()]
    .filter((e) => e.users === 0)
    .sort((a, b) => a.usedAt - b.usedAt)
  for (const old of unused.slice(0, Math.max(0, unused.length - MAX_KEPT))) close(old)
}

/** Opens it, unless it is open already: shown next, it costs no wait. */
export function prepare(target: EditTarget) {
  const entry = entries.get(keyOf(target)) ?? start(target)
  entry.usedAt = Date.now()
  schedule(entry)
}
setOpener(prepare)

function acquire(target: EditTarget) {
  const entry = entries.get(keyOf(target)) ?? start(target)
  entry.users++
  entry.shown = true
  entry.usedAt = Date.now()
  clearTimeout(entry.timer)
  return entry
}

function release(entry: Entry) {
  entry.users--
  entry.usedAt = Date.now()
  if (entry.users > 0) return
  const { connection, error, deleted, session } = entry.state
  // No longer here: the others' faces go (LiveEditor). Shown again, the editor sets it back.
  connection?.provider.awareness.setLocalStateField('user', null)
  if (error || deleted || (session && !session.live)) return close(entry)
  schedule(entry)
}

/** The document `target`, open as long as this is mounted, and kept a while after. */
export function useLiveSession(target: EditTarget): LiveSession {
  const key = keyOf(target)
  useEffect(() => {
    const entry = acquire(JSON.parse(key) as EditTarget)
    return () => release(entry)
  }, [key])
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(key)
      }
    },
    [key],
  )
  const snapshot = useCallback(() => entries.get(key)?.state ?? EMPTY, [key])
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}
