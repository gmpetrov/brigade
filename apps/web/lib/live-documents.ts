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
import { setForget, setOpener, takeAskedSession } from '@/lib/prepare-document'

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
  /**
   * Edits wait for the room's check on its next connection: the first, and one made again when
   * a kept document is shown again (a notice of a change the room missed meanwhile, say).
   */
  holdNext: boolean
  /** When the room last checked what it has against the stored text. */
  checkedAt?: number
  /** Asks the room to check again, edits waiting for `checked`. */
  recheck?: () => void
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
    holdNext: true,
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
  let checking = false
  // The room can be asked to check again on this connection (apps/collab, onCustomMessage).
  let checks = false
  const checked = () => {
    entry.holdNext = false
    entry.checkedAt = Date.now()
    // Not shown: held until shown, which decides (acquire).
    const held = !entry.users
    if (entry.state.held !== held) update(entry, { held })
  }
  provider.on('status', ({ status }: { status: string }) => {
    if (status !== 'connecting') return
    checking = false
    checks = false
  })
  provider.on('custom-message', (message: string) => {
    let notice: { type?: string; checks?: boolean }
    try {
      notice = JSON.parse(message) as typeof notice
    } catch {
      return
    }
    if (notice.checks) checks = true
    // Otherwise (a reconnect after a network drop), what was typed meanwhile is the person's.
    if (notice.type === 'checking') {
      checking = true
      if (entry.holdNext) update(entry, { held: true })
    }
    if (notice.type === 'checked') checked()
  })
  // Synced without `checking`: the room checked before it synced (it had nothing to show yet).
  provider.on('sync', (synced: boolean) => {
    if (synced && !checking) checked()
  })
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event?.code !== 4404) return
    provider.disconnect()
    update(entry, { deleted: true })
    if (!entry.users) close(entry)
  })
  entry.recheck = () => {
    if (checks && provider.wsconnected)
      return provider.sendMessage(JSON.stringify({ type: 'check' }))
    // A room from before it could be asked: connecting again makes it check.
    provider.disconnect()
    void provider.connect()
  }
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

/**
 * Someone else signed in, or the workspace changed: nothing open is reused. What shows a
 * document now opens it again, as that person, in that workspace: the API decides afresh.
 */
function forgetAll() {
  for (const entry of [...entries.values()]) {
    close(entry)
    if (!entry.users) continue
    const again = start(entry.target)
    again.users = entry.users
    again.shown = true
  }
}
setForget(forgetAll)

/** A kept document shown again within this long of the room's check is not checked again. */
const FRESH_MS = 2000

function acquire(target: EditTarget) {
  const kept = entries.get(keyOf(target))
  const entry = kept ?? start(target)
  const connection = entry.state.connection
  // Shown again from what was kept: at once, but edits wait for the room to check what it has
  // against the stored text again, as on connecting (the API's notice of a change made
  // meanwhile is best effort). It starts read only already (release, checked), so the editor
  // never flashes editable first.
  if (kept && !entry.users && connection && !entry.state.deleted && entry.checkedAt !== undefined) {
    if (Date.now() - entry.checkedAt > FRESH_MS) {
      entry.holdNext = true
      entry.recheck?.()
    } else if (entry.state.held) update(entry, { held: false })
  }
  entry.users++
  entry.shown = true
  entry.usedAt = Date.now()
  clearTimeout(entry.timer)
  return entry.key
}

function release(key: string) {
  // The entry now (opened again since, after someone else signed in, say).
  const entry = entries.get(key)
  if (!entry) return
  entry.users--
  entry.usedAt = Date.now()
  if (entry.users > 0) return
  const { connection, error, deleted, session } = entry.state
  // No longer here: the others' faces go (LiveEditor). Shown again, the editor sets it back.
  connection?.provider.awareness.setLocalStateField('user', null)
  if (error || deleted || (session && !session.live)) return close(entry)
  // Shown again, it starts read only, until it is known to be up to date (acquire).
  if (!entry.state.held) update(entry, { held: true })
  schedule(entry)
}

/** The document `target`, open as long as this is mounted, and kept a while after. */
export function useLiveSession(target: EditTarget): LiveSession {
  const key = keyOf(target)
  useEffect(() => {
    acquire(JSON.parse(key) as EditTarget)
    return () => release(key)
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
