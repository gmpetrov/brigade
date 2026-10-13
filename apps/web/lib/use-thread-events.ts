'use client'
import { ApiToBrowser, SequencedEvent } from '@brigade/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { WS_URL } from './config'

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

/**
 * Follow a thread live. Opens on its latest page of events, then replays
 * after every reconnect from the last contiguous sequence number seen.
 * `firstSeq` is the oldest event loaded in order: `events` also holds a few
 * older ones the whole thread needs (its context); `loadOlder` pages in more.
 * `loaded` turns true once its latest page is in; `reconnect` tries again at once.
 */
export function useThreadEvents(sessionId: string, onStatus?: (status: string) => void) {
  const [events, setEvents] = useState<SequencedEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [firstSeq, setFirstSeq] = useState(1)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // The last event of the latest page, from its `history`: in, the thread has loaded.
  const pageEnd = useRef<number>(undefined)
  const reconnectRef = useRef<() => void>(() => undefined)
  const bySeq = useRef(new Map<number, SequencedEvent>())
  const first = useRef(1)
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

  useEffect(() => {
    thread.current = sessionId
    bySeq.current = new Map()
    pageEnd.current = undefined
    setEvents([])
    setLoaded(false)
    begin(1)
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 500
    let stopped = false

    const contiguous = () => {
      let seq = first.current - 1
      while (bySeq.current.has(seq + 1)) seq++
      return seq
    }

    const connect = () => {
      socket = new WebSocket(`${WS_URL}/api/ws`)
      socket.onopen = () => {
        delay = 500
        setConnected(true)
        socket!.send(
          JSON.stringify({ type: 'subscribe', sessionId, afterSeq: contiguous(), tail: true }),
        )
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
        else if (data.type === 'history' && data.sessionId === sessionId) {
          begin(data.firstSeq)
          // An empty thread, or an API too old to say where the page ends: loaded now.
          const end = data.lastSeq ?? 0
          pageEnd.current = end
          if (end < data.firstSeq) setLoaded(true)
          add(data.context)
        } else if (data.type === 'thread.updated' && data.sessionId === sessionId) {
          statusRef.current?.(data.status)
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

  const reconnect = useCallback(() => reconnectRef.current(), [])

  return { events, connected, firstSeq, loadOlder, loadingOlder, loaded, reconnect }
}
