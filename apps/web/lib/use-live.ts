'use client'
import { ApiToBrowser } from '@brigade/contracts'
import { useEffect, useRef } from 'react'
import { WS_URL } from './config'

/** Listen to the dashboard socket for workspace and member updates. */
export function useLive(onMessage: (message: ApiToBrowser) => void) {
  const handler = useRef(onMessage)
  handler.current = onMessage
  useEffect(() => {
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const connect = () => {
      socket = new WebSocket(`${WS_URL}/api/ws`)
      socket.onmessage = (event) => {
        const parsed = ApiToBrowser.safeParse(JSON.parse(String(event.data)))
        if (parsed.success) handler.current(parsed.data)
      }
      socket.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [])
}
