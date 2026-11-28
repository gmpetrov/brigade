'use client'
// A preview on a member's own machine opens at http://<thread>.localhost:<port>, in a frame of the
// dashboard's HTTPS page (docs/previews.md). Whether the browser shows it there:
// - Chrome asks first: a public page reaching the computer's own addresses needs its Local
//   Network Access permission (loopback-network, formerly local-network-access), asked once for
//   the dashboard's site. Until it is allowed, the frame shows Chrome's blocked page.
// - Brigade.app (Electron) shows it: its Chromium does not ask, and its session allows it.
// - Safari (WebKit) never does: it blocks an http frame of the computer under an HTTPS page.
import { useEffect, useState } from 'react'
import { inDesktopApp } from '@/lib/brigade-app'

/**
 * - `frame`: the frame shows it.
 * - `ask`: the browser asks the person first; the frame shows it once they allow it.
 * - `denied`: they refused; the frame shows it once they allow it in the site's settings.
 * - `tab`: this browser never shows it in a frame, only in a tab of its own.
 */
export type LocalAccess = 'frame' | 'ask' | 'denied' | 'tab'

/** The engine a user agent names, for what it does with a frame of the computer. */
export function frameEngine(userAgent: string): 'chromium' | 'webkit' | 'other' {
  if (/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return 'chromium'
  // Safari, and every browser on an iPhone or iPad (CriOS, FxiOS: WebKit underneath).
  if (/AppleWebKit\//.test(userAgent) && !/Gecko\/\d/.test(userAgent)) return 'webkit'
  return 'other'
}

/** Chrome's permission for reaching the computer's own addresses, by its names old and new. */
const PERMISSIONS = ['loopback-network', 'local-network-access']

/** What a browser permission's state means for the frame. */
export const accessOf = (state: PermissionState): LocalAccess =>
  state === 'granted' ? 'frame' : state === 'denied' ? 'denied' : 'ask'

/** Whether this browser shows a preview on this computer in the dashboard's frame, kept up to date. */
export function useLocalAccess(local: boolean | undefined): LocalAccess {
  const [access, setAccess] = useState<LocalAccess>('frame')
  useEffect(() => {
    setAccess('frame')
    if (!local || inDesktopApp()) return
    const engine = frameEngine(navigator.userAgent)
    if (engine === 'webkit') return setAccess('tab')
    if (engine !== 'chromium' || !navigator.permissions) return
    let status: PermissionStatus | undefined
    let live = true
    const update = () => status && setAccess(accessOf(status.state))
    void (async () => {
      for (const name of PERMISSIONS) {
        try {
          status = await navigator.permissions.query({ name: name as PermissionName })
          break
        } catch {
          // Not a permission this version knows: the next name, else none (it does not ask).
        }
      }
      if (!live || !status) return
      update()
      status.addEventListener('change', update)
    })()
    return () => {
      live = false
      status?.removeEventListener('change', update)
    }
  }, [local])
  return access
}

/**
 * The frame's permissions: on this computer, what Chrome asks before a public page reaches it
 * (every name it has had: an unknown one is ignored).
 */
export const frameAllow = (local: boolean | undefined) =>
  [
    'clipboard-read',
    'clipboard-write',
    'fullscreen',
    ...(local ? ['loopback-network', 'local-network', 'local-network-access'] : []),
  ].join('; ')
