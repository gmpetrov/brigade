// Notifications: web push to the dashboard, installed as an app or open in a
// browser. Sparse by design: what waits on a person, and with a preset, finished work.
import { z } from 'zod'

/**
 * needed: what waits on the member (the Needs you items that are theirs).
 * finished: and each task done or pull request merged, once it is.
 * everything: and replies in threads they started.
 */
export const NotifyPreset = z.enum(['needed', 'finished', 'everything'])
export type NotifyPreset = z.infer<typeof NotifyPreset>

/** A member's notification settings, and the key their browser subscribes with (null: not set up). */
export type NotificationSettings = {
  preset: NotifyPreset
  publicKey: string | null
}

export const SetNotifyPreset = z.object({ preset: NotifyPreset })

/** A browser's push subscription, as PushSubscription.toJSON() gives it. */
export const PushDeviceInput = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
})

/** What a push carries to the service worker (apps/web/public/sw.js). */
export type PushMessage = {
  title: string
  body: string
  /** The dashboard path a click opens. */
  url: string
  /** Notifications with the same tag replace each other: one per thread. */
  tag: string
  /** The app icon badge: how many things wait on the member. Unset: leave it as it is. */
  badge?: number
  /** Tags of notifications to close: what they were about no longer waits. */
  close: string[]
}
