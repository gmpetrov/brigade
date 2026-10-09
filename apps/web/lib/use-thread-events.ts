'use client'
import { ApiToBrowser, SequencedEvent } from '@brigade/contracts'
import { useEffect, useRef, useState } from 'react'
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
 * Follow a thread live. Replays stored events on connect and after every
 * reconnect, from the last contiguous sequence number seen.
 */
export function useThreadEvents(sessionId: string, onStatus?: (status: string) => void) {
  const [events, setEvents] = useState<SequencedEvent[]>([])
  const [connected, setConnected] = useState(false)
  const bySeq = useRef(new Map<number, SequencedEvent>())
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus

  useEffect(() => {
    bySeq.current = new Map()
    setEvents([])
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 500
    let stopped = false

    const contiguous = () => {
      let seq = 0
      while (bySeq.current.has(seq + 1)) seq++
      return seq
    }

    const connect = () => {
      socket = new WebSocket(`${WS_URL}/api/ws`)
      socket.onopen = () => {
        delay = 500
        setConnected(true)
        socket!.send(JSON.stringify({ type: 'subscribe', sessionId, afterSeq: contiguous() }))
      }
      socket.onmessage = (message) => {
        const raw = JSON.parse(String(message.data)) as { type?: string; events?: unknown[] }
        const parsed = ApiToBrowser.safeParse(
          raw.type === 'events' ? { ...raw, events: (raw.events ?? []).map(known) } : raw,
        )
        if (!parsed.success) return
        const data = parsed.data
        if (data.type === 'events') {
          let changed = false
          for (const e of data.events) {
            if (e.sessionId !== sessionId || bySeq.current.has(e.seq)) continue
            bySeq.current.set(e.seq, e)
            changed = true
          }
          if (changed) setEvents([...bySeq.current.values()].sort((a, b) => a.seq - b.seq))
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
    return () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId])

  return { events, connected }
}
