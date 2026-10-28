'use client'
import { ApiToBrowser, SequencedEvent } from '@brigade/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, preload, preloaded } from './api'
import { keepAlive, liveSocket } from './live-socket'

/**
 * An event this dashboard does not know (a newer runner or API) becomes an
 * ignored placeholder, so the rest of its batch still shows and the sequence
 * stays contiguous.
 */
function known(e: unknown): unknown {
  if (SequencedEvent.safeParse(e).success) return e
  const { sessionId, seq } = e as { sessionId: string; seq: number }
  return {
    sessionId,
    seq,
    event: { type: 'raw', source: 'unsupported', value: null, at: new Date(0).toISOString() },
  }
}

/** A thread's latest page of events, and what the whole thread needs from before it. */
const latestPage = (sessionId: string) => `/threads/${sessionId}/events`

type LatestPage = { firstSeq: number; lastSeq: number; context: unknown[]; events: unknown[] }

/** Sends a thread's latest page ahead (lib/api.ts's `preload`), for it to open on. */
export const preloadThreadEvents = (sessionId: string) => preload(latestPage(sessionId))

/**
 * Follow a thread live. Opens on its latest page of events, asked for with the
 * thread (one trip, where a socket takes two: it opens, then it is asked), then
 * replays after every reconnect from the last contiguous sequence number seen.
 * `firstSeq` is the oldest event loaded in order: `events` also holds a few
 * older ones the whole thread needs (its context); `loadOlder` pages in more.
 * `loaded` turns true once its latest page is in; `reconnect` tries again at once.
 */
/** Whether a thread's computer is there, as its socket says on subscribing. */
export type ComputerAvailability = {
  /** The computer it is about: the thread may have moved since the page loaded it. */
  id: string
  online: boolean
  restarting: boolean
  status?: string
}

/**
 * Events not loaded between two stretches that are: `from` up to, not including, `to`. One
 * opens when the timeline jumps to an older message, which loads only that message's page.
 */
export type EventGap = { from: number; to: number }

/** A page the timeline asked for: where it starts and ends, not included. */
type JumpPage = { firstSeq: number; endSeq: number; events: SequencedEvent[] }

export function useThreadEvents(
  sessionId: string,
  onStatus?: (status: string, computer?: ComputerAvailability) => void,
) {
  const [events, setEvents] = useState<SequencedEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [firstSeq, setFirstSeq] = useState(1)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [gaps, setGaps] = useState<EventGap[]>([])
  // The last event of the latest page, from its `history`: in, the thread has loaded.
  const pageEnd = useRef<number>(undefined)
  const reconnectRef = useRef<() => void>(() => undefined)
  const bySeq = useRef(new Map<number, SequencedEvent>())
  const first = useRef(1)
  // In order, oldest first; what the socket follows starts after the last one.
  const gapsRef = useRef<EventGap[]>([])
  const loading = useRef(false)
  // The thread shown now: a page or batch that arrives for another one is dropped.
  const thread = useRef(sessionId)
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus

  const add = useCallback((list: SequencedEvent[]) => {
    let changed = false
    for (const e of list) {
      if (e.sessionId !== thread.current || bySeq.current.has(e.seq)) continue
      bySeq.current.set(e.seq, e)
      changed = true
    }
    if (changed) setEvents([...bySeq.current.values()].sort((a, b) => a.seq - b.seq))
    if (pageEnd.current !== undefined && bySeq.current.has(pageEnd.current)) setLoaded(true)
  }, [])
  const begin = (seq: number) => {
    first.current = seq
    setFirstSeq(seq)
  }
  const holes = (list: EventGap[]) => {
    gapsRef.current = list.filter((g) => g.from < g.to)
    setGaps(gapsRef.current)
  }

  useEffect(() => {
    thread.current = sessionId
    bySeq.current = new Map()
    pageEnd.current = undefined
    setEvents([])
    setLoaded(false)
    begin(1)
    holes([])
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 500
    let stopped = false

    // From the end of the last gap: what is before it is not for the socket to bring.
    const contiguous = () => {
      let seq = (gapsRef.current.at(-1)?.to ?? first.current) - 1
      while (bySeq.current.has(seq + 1)) seq++
      return seq
    }
    // The latest page: where it starts, where it ends (in, the thread has loaded), its events.
    const openOn = (firstSeq: number, lastSeq: number, events: SequencedEvent[]) => {
      begin(firstSeq)
      pageEnd.current = lastSeq
      if (lastSeq < firstSeq) setLoaded(true)
      add(events)
    }

    // A socket asks once the page is in, for what follows it: asked from nothing, the API
    // would send the page again. Without it (an API too old to send it), it asks for the page.
    let paged = false
    const subscribe = () => {
      if (!paged || socket?.readyState !== WebSocket.OPEN) return
      socket.send(
        JSON.stringify({ type: 'subscribe', sessionId, afterSeq: contiguous(), tail: true }),
      )
    }
    const path = latestPage(sessionId)
    void (preloaded<LatestPage>(path) ?? api<LatestPage>(path))
      .then((page) => {
        if (stopped) return
        const events = [...page.context, ...page.events].map((e) => known(e) as SequencedEvent)
        openOn(page.firstSeq, page.lastSeq, events)
      })
      .catch(() => undefined)
      .finally(() => {
        paged = true
        if (!stopped) subscribe()
      })

    let alive: (() => void) | undefined
    const connect = () => {
      alive?.()
      socket = liveSocket()
      alive = keepAlive(socket)
      socket.onopen = () => {
        delay = 500
        setConnected(true)
        subscribe()
      }
      socket.onmessage = (message) => {
        const raw = JSON.parse(String(message.data)) as {
          type?: string
          events?: unknown[]
          context?: unknown[]
        }
        const parsed = ApiToBrowser.safeParse(
          raw.type === 'events'
            ? { ...raw, events: (raw.events ?? []).map(known) }
            : raw.type === 'history'
              ? { ...raw, context: (raw.context ?? []).map(known) }
              : raw,
        )
        if (!parsed.success) return
        const data = parsed.data
        if (data.type === 'events') add(data.events)
        else if (data.type === 'history' && data.sessionId === sessionId)
          // An empty thread, or an API too old to say where the page ends: loaded now.
          openOn(data.firstSeq, data.lastSeq ?? 0, data.context)
        else if (data.type === 'thread.updated' && data.sessionId === sessionId) {
          statusRef.current?.(data.status, data.computer)
        }
      }
      socket.onclose = () => {
        setConnected(false)
        if (stopped) return
        retry = setTimeout(connect, delay)
        delay = Math.min(delay * 2, 10_000)
      }
    }
    connect()
    // Tried again now, not after the backoff: a connection that hangs is dropped first.
    reconnectRef.current = () => {
      clearTimeout(retry)
      delay = 500
      const old = socket
      if (old) {
        old.onclose = null
        old.onmessage = null
        old.close()
      }
      setConnected(false)
      connect()
    }
    return () => {
      stopped = true
      clearTimeout(retry)
      alive?.()
      socket?.close()
    }
  }, [sessionId, add])

  /**
   * Load the page before the oldest event loaded; resolves at once when there is
   * none or one is loading. `beforeShow` runs just before the page goes in.
   */
  const loadOlder = useCallback(
    async (beforeShow?: () => void) => {
      const before = first.current
      if (before <= 1 || loading.current) return
      loading.current = true
      setLoadingOlder(true)
      try {
        const page = await api<{ firstSeq: number; events: SequencedEvent[] }>(
          `/threads/${sessionId}/events?before=${before}`,
        )
        if (thread.current !== sessionId || first.current !== before) return
        beforeShow?.()
        add(page.events.map((e) => known(e) as SequencedEvent))
        begin(page.firstSeq)
      } finally {
        loading.current = false
        setLoadingOlder(false)
      }
    },
    [sessionId, add],
  )

  /**
   * Load the page holding `seq`, an event before the oldest loaded or in a gap, and only
   * it: what lies between stays a gap, loaded as someone scrolls into it. Resolves once it
   * is in, at once when the event is loaded already.
   */
  const jumpTo = useCallback(
    async (seq: number) => {
      if (loading.current || (bySeq.current.has(seq) && !inGap(gapsRef.current, seq))) return
      const gap = gapsRef.current.find((g) => g.from <= seq && seq < g.to)
      // Before the oldest loaded: as a gap from the thread's start.
      const top = first.current
      const until = gap ? gap.to : top
      if (seq >= until) return
      loading.current = true
      try {
        const page = await api<JumpPage>(`/threads/${sessionId}/events?from=${seq}&until=${until}`)
        if (thread.current !== sessionId || first.current !== top) return
        if (gap && !gapsRef.current.includes(gap)) return
        add(page.events.map((e) => known(e) as SequencedEvent))
        if (gap)
          holes(
            gapsRef.current.flatMap((g) =>
              g === gap
                ? [
                    { from: g.from, to: Math.max(g.from, page.firstSeq) },
                    { from: Math.min(page.endSeq, g.to), to: g.to },
                  ]
                : [g],
            ),
          )
        else {
          holes([{ from: page.endSeq, to: top }, ...gapsRef.current])
          begin(page.firstSeq)
        }
      } finally {
        loading.current = false
      }
    },
    [sessionId, add],
  )

  /**
   * Load a page of a gap: its first one, read down into it, or its last one, read up
   * into it. `beforeShow` runs just before the page goes in.
   */
  const fillGap = useCallback(
    async (gap: EventGap, end: 'first' | 'last', beforeShow?: () => void) => {
      if (loading.current) return
      loading.current = true
      try {
        const page =
          end === 'first'
            ? await api<JumpPage>(`/threads/${sessionId}/events?from=${gap.from}&until=${gap.to}`)
            : await api<{ firstSeq: number; events: SequencedEvent[] }>(
                `/threads/${sessionId}/events?before=${gap.to}&since=${gap.from}`,
              ).then((p) => ({ ...p, endSeq: gap.to }))
        const now = gapsRef.current.find((g) => g.from === gap.from && g.to === gap.to)
        if (thread.current !== sessionId || !now) return
        beforeShow?.()
        add(page.events.map((e) => known(e) as SequencedEvent))
        holes(
          gapsRef.current.flatMap((g) =>
            g === now
              ? [
                  { from: g.from, to: Math.max(g.from, page.firstSeq) },
                  { from: Math.min(page.endSeq, g.to), to: g.to },
                ]
              : [g],
          ),
        )
      } finally {
        loading.current = false
      }
    },
    [sessionId, add],
  )

  const reconnect = useCallback(() => reconnectRef.current(), [])

  return {
    events,
    connected,
    firstSeq,
    gaps,
    loadOlder,
    loadingOlder,
    jumpTo,
    fillGap,
    loaded,
    reconnect,
  }
}

/** Whether `seq` falls in one of the gaps. */
export const inGap = (gaps: EventGap[], seq: number) =>
  gaps.some((g) => g.from <= seq && seq < g.to)
