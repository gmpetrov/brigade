'use client'
import { DemoMachine } from '@/components/demo-machine'
import { DEMO } from '@/lib/demo/flag'
import type RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'
import { bridgeInput, type DesktopClipboard, type DesktopInput } from '@/lib/desktop-input'
import { cn } from '@/lib/utils'

export type DesktopConnection = { socketUrl: string; password: string }

/** How far two fingers zoom in on the screen. */
const MAX_ZOOM = 4

type Gesture = CustomEvent<{
  type: string
  clientX: number
  clientY: number
  magnitudeX: number
  magnitudeY: number
}>

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * A live VNC desktop: the screen only, scaled to fit, no noVNC chrome. With
 * `control`, mouse and keyboard go to the desktop, clipboard included. With
 * `zoom`, two fingers pinch to zoom in on it, and drag to move around it once
 * zoomed (else they scroll the desktop).
 */
function LiveDesktopView({
  connection,
  control,
  focus,
  zoom,
  clipboard,
  onInput,
  onConnect,
  onLost,
}: {
  connection: DesktopConnection
  control: boolean
  zoom?: boolean
  /** The desktop's clipboard, beyond what VNC carries. */
  clipboard?: DesktopClipboard
  /** Take keyboard focus as soon as the screen shows. */
  focus?: boolean
  /** What buttons can do with the keyboard and clipboard, while connected. */
  onInput?: (input: DesktopInput | undefined) => void
  onConnect?: () => void
  /** The connection dropped or was refused: open a new one. */
  onLost: (reason: string) => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const [connected, setConnected] = useState(false)
  const lost = useRef(onLost)
  lost.current = onLost
  const connect = useRef(onConnect)
  connect.current = onConnect
  const clip = useRef(clipboard)
  clip.current = clipboard
  const inputs = useRef(onInput)
  inputs.current = onInput
  const initial = useRef({ control, focus })
  initial.current = { control, focus }

  useEffect(() => {
    const target = screen.current
    if (!target) return
    let client: RFB | undefined
    let bridge: DesktopInput | undefined
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
      // On a touch screen a tap must not take focus from the on-screen keyboard's field.
      client.focusOnClick = !window.matchMedia('(pointer: coarse)').matches
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
      bridge = bridgeInput(
        client,
        target,
        clip.current && {
          set: (text) => clip.current!.set(text),
          get: () => clip.current!.get(),
        },
      )
      inputs.current?.(bridge)
      rfb.current = client
    })
    return () => {
      closed = true
      bridge?.dispose()
      inputs.current?.(undefined)
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

  // Zoom: the screen laid out bigger than its frame, so noVNC draws it sharp and
  // maps taps right, and moved within it. noVNC tells pinches and two-finger
  // drags apart; those that zoom or move never reach it.
  useEffect(() => {
    const root = frame.current
    const target = screen.current
    if (!zoom || !root || !target) return
    let scale = 1
    let x = 0
    let y = 0
    let start: { scale: number; x: number; y: number; d: number; ax: number; ay: number } | null =
      null
    let kind: string | null = null

    // Within the desktop, not the bars beside it: noVNC centres the screen, fit, in its box.
    const within = (at: number, frameSize: number, size: number, other: number, fb: number) => {
      const box = scale * frameSize
      const fit = Math.min(box / size, (scale * other) / fb) * size
      const start = (box - fit) / 2
      return fit <= frameSize
        ? start - (frameSize - fit) / 2
        : clamp(at, start, start + fit - frameSize)
    }
    const apply = () => {
      const desktop = target.querySelector('canvas')
      const w = root.clientWidth
      const h = root.clientHeight
      if (desktop?.width && desktop.height) {
        x = within(x, w, desktop.width, h, desktop.height)
        y = within(y, h, desktop.height, w, desktop.width)
      } else {
        x = clamp(x, 0, (scale - 1) * w)
        y = clamp(y, 0, (scale - 1) * h)
      }
      target.style.width = `${scale * 100}%`
      target.style.height = `${scale * 100}%`
      target.style.transform = scale === 1 ? '' : `translate(${-x}px, ${-y}px)`
    }

    const onGesture = (e: Event) => {
      const { detail } = e as Gesture
      if (e.type === 'gesturestart') {
        kind =
          detail.type === 'pinch' || (detail.type === 'twodrag' && scale > 1) ? detail.type : null
        const box = root.getBoundingClientRect()
        start = {
          scale,
          x,
          y,
          d: Math.hypot(detail.magnitudeX, detail.magnitudeY),
          ax: detail.clientX - box.left,
          ay: detail.clientY - box.top,
        }
      }
      if (!kind || !start) return
      e.stopPropagation()
      if (e.type === 'gesturemove') {
        if (kind === 'pinch') {
          if (!start.d) return
          // The point between the fingers stays under them.
          scale = clamp(
            (start.scale * Math.hypot(detail.magnitudeX, detail.magnitudeY)) / start.d,
            1,
            MAX_ZOOM,
          )
          x = ((start.x + start.ax) * scale) / start.scale - start.ax
          y = ((start.y + start.ay) * scale) / start.scale - start.ay
        } else {
          x = start.x - detail.magnitudeX
          y = start.y - detail.magnitudeY
        }
        apply()
      }
      if (e.type === 'gestureend') {
        // Close to the whole screen: snap back to it.
        if (scale < 1.05) scale = 1
        apply()
        kind = null
        start = null
      }
    }

    // noVNC's gesture events don't bubble: caught on their way down.
    const events = ['gesturestart', 'gesturemove', 'gestureend']
    for (const type of events) root.addEventListener(type, onGesture, true)
    const resized = new ResizeObserver(apply)
    resized.observe(root)
    return () => {
      for (const type of events) root.removeEventListener(type, onGesture, true)
      resized.disconnect()
      target.style.width = ''
      target.style.height = ''
      target.style.transform = ''
    }
  }, [zoom])

  return (
    <div ref={frame} className="relative size-full overflow-hidden">
      <div
        ref={screen}
        // Its keys go to the remote desktop, Escape included: no panel closes on it.
        data-keyboard
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

/** In the demo, what it would show: there is no computer behind it (components/demo-machine.tsx). */
export function DesktopView(props: Parameters<typeof LiveDesktopView>[0]) {
  return DEMO ? <DemoMachine what="screen" /> : <LiveDesktopView {...props} />
}
