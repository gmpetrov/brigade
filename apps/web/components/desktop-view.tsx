'use client'
import type RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'
import { bridgeInput, type DesktopClipboard } from '@/lib/desktop-input'
import { cn } from '@/lib/utils'

export type DesktopConnection = { socketUrl: string; password: string }

/**
 * A live VNC desktop: the screen only, scaled to fit, no noVNC chrome. With
 * `control`, mouse and keyboard go to the desktop, clipboard included.
 */
export function DesktopView({
  connection,
  control,
  focus,
  clipboard,
  onConnect,
  onLost,
}: {
  connection: DesktopConnection
  control: boolean
  /** The desktop's clipboard, beyond what VNC carries. */
  clipboard?: DesktopClipboard
  /** Take keyboard focus as soon as the screen shows. */
  focus?: boolean
  onConnect?: () => void
  /** The connection dropped or was refused: open a new one. */
  onLost: (reason: string) => void
}) {
  const screen = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const [connected, setConnected] = useState(false)
  const lost = useRef(onLost)
  lost.current = onLost
  const connect = useRef(onConnect)
  connect.current = onConnect
  const clip = useRef(clipboard)
  clip.current = clipboard
  const initial = useRef({ control, focus })
  initial.current = { control, focus }

  useEffect(() => {
    const target = screen.current
    if (!target) return
    let client: RFB | undefined
    let unbridge: (() => void) | undefined
    let closed = false
    // noVNC logs an error when a client that already dropped is disconnected again.
    let ended = false
    setConnected(false)
    // noVNC touches browser APIs as it loads: only here, never on the server.
    void import('@novnc/novnc').then(({ default: RFBClient }) => {
      if (closed) return
      client = new RFBClient(target, connection.socketUrl, {
        credentials: { password: connection.password },
      })
      client.scaleViewport = true
      client.background = 'transparent'
      client.showDotCursor = false
      client.qualityLevel = 7
      client.compressionLevel = 2
      client.viewOnly = !initial.current.control
      client.addEventListener('connect', () => {
        setConnected(true)
        connect.current?.()
        if (initial.current.focus && initial.current.control) client?.focus({ preventScroll: true })
      })
      client.addEventListener('disconnect', (e) => {
        ended = true
        setConnected(false)
        if (!closed)
          lost.current((e as CustomEvent<{ clean: boolean }>).detail.clean ? 'closed' : 'lost')
      })
      client.addEventListener('securityfailure', () => {
        if (!closed) lost.current('refused')
      })
      unbridge = bridgeInput(
        client,
        target,
        clip.current && {
          set: (text) => clip.current!.set(text),
          get: () => clip.current!.get(),
        },
      )
      rfb.current = client
    })
    return () => {
      closed = true
      unbridge?.()
      if (!ended) client?.disconnect()
      rfb.current = null
    }
  }, [connection])

  useEffect(() => {
    const client = rfb.current
    if (!client) return
    client.viewOnly = !control
    if (control && focus) client.focus({ preventScroll: true })
  }, [control, focus])

  return (
    <div className="relative size-full">
      <div
        ref={screen}
        className={cn(
          'size-full [&_canvas]:rounded-md',
          control &&
            '[&_canvas:focus]:outline-2 [&_canvas:focus]:-outline-offset-2 [&_canvas:focus]:outline-primary',
        )}
      />
      {!connected && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Connecting to the desktop…
        </p>
      )}
    </div>
  )
}
