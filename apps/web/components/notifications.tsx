'use client'
// Notifications: the panel in Settings > Preferences (NotificationsPanel), where they
// turn them on for this device and pick a preset, and what the dashboard does for
// them while open (useAppNotifications). The API decides what to send and when
// (apps/api/src/notifications.ts); public/sw.js shows it.
import type { NotificationSettings, NotifyPreset } from '@brigade/contracts'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { api, useApi } from '@/lib/api'

const PRESETS: { value: NotifyPreset; label: string; detail: string }[] = [
  {
    value: 'needed',
    label: 'Only when I’m needed',
    detail: 'Approvals, questions, sign-ins and pull requests waiting on you.',
  },
  {
    value: 'finished',
    label: 'Needed + finished work',
    detail: 'Also each task done and pull request merged.',
  },
  {
    value: 'everything',
    label: 'Everything',
    detail: 'Also replies in threads you started.',
  },
]

const supported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** An iPhone or iPad browsing, not opened from the Home Screen: no notifications there. */
const iosInBrowser = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !window.matchMedia('(display-mode: standalone)').matches

const registration = () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })

const keyBytes = (base64url: string) => {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** Tell the API this browser receives the member's notifications. */
const saveDevice = (subscription: PushSubscription) =>
  api('/notifications/devices', { body: subscription.toJSON() })

/**
 * While the dashboard is open: the service worker installed, this device's
 * subscription kept with the API, the app icon badge counting what needs the
 * member (as the sidebar does), and their notifications cleared once they look.
 */
export function useAppNotifications(needsYou: number) {
  useEffect(() => {
    if (!supported()) return
    void (async () => {
      const reg = await registration()
      // Signed in as someone else in this browser, or the API forgot it: claim it again.
      const subscription = await reg.pushManager.getSubscription()
      if (subscription && Notification.permission === 'granted')
        await saveDevice(subscription).catch(() => {})
    })().catch(() => {})
  }, [])

  useEffect(() => {
    if (!('setAppBadge' in navigator)) return
    void (needsYou > 0 ? navigator.setAppBadge(needsYou) : navigator.clearAppBadge()).catch(
      () => {},
    )
  }, [needsYou])

  useEffect(() => {
    if (!supported()) return
    const clear = async () => {
      if (document.visibilityState !== 'visible') return
      const reg = await navigator.serviceWorker.getRegistration()
      for (const n of (await reg?.getNotifications()) ?? []) n.close()
    }
    void clear().catch(() => {})
    const onVisible = () => void clear().catch(() => {})
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}

type DeviceState = 'unsupported' | 'install' | 'blocked' | 'off' | 'on'

async function deviceState(): Promise<DeviceState> {
  if (!supported()) return iosInBrowser() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  const reg = await navigator.serviceWorker.getRegistration()
  const subscription = await reg?.pushManager.getSubscription()
  return subscription && Notification.permission === 'granted' ? 'on' : 'off'
}

export function NotificationsPanel() {
  const settings = useApi<NotificationSettings>('/notifications')
  const [preset, setPreset] = useState<NotifyPreset>()
  const [device, setDevice] = useState<DeviceState>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()

  const refresh = useCallback(() => void deviceState().then(setDevice), [])
  useEffect(refresh, [refresh])
  useEffect(() => setPreset(settings.data?.preset), [settings.data?.preset])

  const publicKey = settings.data?.publicKey

  async function turnOn() {
    if (!publicKey) return
    setBusy(true)
    setNote(undefined)
    try {
      // Asked in the tap itself: Safari allows it only there.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return
      const reg = await registration()
      await navigator.serviceWorker.ready
      const subscription =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }))
      await saveDevice(subscription)
    } catch (e) {
      setNote(`Could not turn them on: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  async function turnOff() {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const subscription = await reg?.pushManager.getSubscription()
      if (subscription) {
        await api('/notifications/devices/remove', { body: { endpoint: subscription.endpoint } })
        await subscription.unsubscribe()
      }
    } finally {
      setBusy(false)
      refresh()
    }
  }

  async function test() {
    setNote(undefined)
    const { devices, sent, errors } = await api<{
      devices: number
      sent: number
      errors: string[]
    }>('/notifications/test', { method: 'POST' })
    setNote(
      sent
        ? `Sent to ${sent} of your ${devices === 1 ? 'device' : `${devices} devices`}. It should show in a few seconds.${errors.length ? ` Not sent: ${errors.join('; ')}` : ''}`
        : devices
          ? `Not sent: ${errors.join('; ') || 'the push service refused it'}`
          : 'Brigade has no device of yours: turn notifications off and on again here.',
    )
  }

  async function choose(value: string) {
    const previous = preset
    setPreset(value as NotifyPreset)
    try {
      await api('/notifications/preset', { method: 'PUT', body: { preset: value } })
    } catch {
      setPreset(previous)
    }
  }

  return (
    <div data-id="notifications-settings">
      {settings.data && !publicKey ? (
        <p className="text-muted-foreground text-sm">
          Notifications are not set up on this Brigade yet.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2" data-id="notifications-device">
            <h3 className="text-sm font-medium">This device</h3>
            {device === 'install' && (
              <p className="text-muted-foreground text-sm">
                On iPhone, add Brigade to your Home Screen first: tap Share, then Add to Home
                Screen. Open it from there and turn notifications on here.
              </p>
            )}
            {device === 'unsupported' && (
              <p className="text-muted-foreground text-sm">
                This browser can’t show notifications.
              </p>
            )}
            {device === 'blocked' && (
              <p className="text-muted-foreground text-sm">
                Notifications are blocked for Brigade. Allow them in this browser’s settings, then
                come back here.
              </p>
            )}
            {device === 'off' && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">Off on this device.</p>
                <Button size="sm" disabled={busy || !publicKey} onClick={() => void turnOn()}>
                  Turn on
                </Button>
              </div>
            )}
            {device === 'on' && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">On for this device.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void test()}>
                    Send a test
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void turnOff()}>
                    Turn off
                  </Button>
                </div>
              </div>
            )}
            {note && <p className="text-muted-foreground text-xs">{note}</p>}
          </section>

          <fieldset className="flex flex-col gap-2" data-id="notifications-preset">
            <legend className="mb-2 text-sm font-medium">Notify me about</legend>
            <RadioGroup
              value={preset ?? ''}
              onValueChange={(value) => void choose(value)}
              disabled={!preset}
              className="gap-3"
            >
              {PRESETS.map((p) => (
                <div key={p.value} className="flex items-start gap-2.5">
                  <RadioGroupItem value={p.value} id={`notify-${p.value}`} className="mt-0.5" />
                  <Label htmlFor={`notify-${p.value}`} className="grid gap-0.5 font-normal">
                    <span className="font-medium">{p.label}</span>
                    <span className="text-muted-foreground text-xs">{p.detail}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>

          <p className="text-muted-foreground text-xs">
            Brigade waits a minute before telling you, so a burst arrives as one notification. It
            stays quiet while you’re looking at Brigade, reminds you once at most, and sends no more
            than 4 an hour.
          </p>
        </div>
      )}
    </div>
  )
}
