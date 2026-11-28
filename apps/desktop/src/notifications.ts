// Brigade's notifications, shown by Brigade.app itself: Electron has no push service, so the
// dashboard's web push can't reach its windows. Turned on in Settings > Notifications, the app
// is a device of the person's (the API's DesktopDevice): the API's sweep queues for it what it
// would push, and the app fetches that every 20 seconds, from the menu bar, its windows open or
// not. Each push is a notification of the system's (Notification Center on macOS), one per
// thread (its tag), whose click opens the thread in the dashboard window; it closes those whose
// thing no longer waits, and sets the app icon's badge. The rules (what, when, how often, quiet
// while the person looks at a dashboard) stay the API's (apps/api/src/notifications.ts).
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Notification } from 'electron'
import { setBadge } from './badge.js'
import { allowedDashboard, dashboard, home } from './settings.js'
import { showDashboard } from './windows.js'

const EVERY_MS = 20_000

/** What a push carries (@brigade/contracts' PushMessage). */
export type PushMessage = {
  title: string
  body: string
  /** The dashboard path a click opens. */
  url: string
  /** Notifications with the same tag replace each other. */
  tag: string
  badge?: number
  /** Tags of notifications to close. */
  close?: string[]
}

export type Device = { api: string; deviceId: string; token: string }

/** The API's address: https, or a local one while developing Brigade. */
export const allowedApi = allowedDashboard

/**
 * Where the device is kept: a file of its own, readable by the person alone, as the runner keeps
 * its token. Not the system keychain: a locked one asks for a password in the middle of a fetch.
 */
const file = () => join(home(), 'notifications.json')

/** The device this app fetches for, if turned on. */
export function device(): Device | undefined {
  try {
    const { api, deviceId, token } = JSON.parse(readFileSync(file(), 'utf8')) as Record<
      string,
      unknown
    >
    if (typeof api !== 'string' || !allowedApi(api)) return undefined
    if (typeof deviceId !== 'string' || typeof token !== 'string') return undefined
    return { api: api.replace(/\/+$/, ''), deviceId, token }
  } catch {
    return undefined
  }
}

function store(next: Device | undefined) {
  try {
    if (!next) return rmSync(file(), { force: true })
    mkdirSync(home(), { recursive: true })
    const temp = `${file()}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file())
  } catch {}
}

let timer: ReturnType<typeof setInterval> | undefined
/**
 * Each start and stop begins a new generation: a fetch still in flight from an older one (the
 * previous account's, before a sign-out) shows nothing and changes nothing once it answers.
 */
let generation = 0
/** The generation whose fetch is in flight, and how to give it up. */
let polling: number | undefined
let inFlight: AbortController | undefined
/** Shown notifications by tag: kept, so a click still finds its handler, and closable. */
const shown = new Map<string, Notification>()

export const supported = () => Notification.isSupported()

/** Turned on from the dashboard, with the device it registered: fetches from now on. */
export function enable(next: Device) {
  if (!allowedApi(next.api)) throw new Error('Not a Brigade API.')
  store(next)
  start()
  // At once, so macOS asks whether Brigade may show notifications while the person is here.
  show({
    title: 'Notifications are on',
    body: 'Brigade will tell you here when something needs you.',
    url: '/app',
    tag: 'brigade-test',
  })
}

/** Turned off (or signing out): no more fetches, and the API forgets the device. Its id. */
export async function disable() {
  const current = device()
  store(undefined)
  stop()
  // Best effort, and briefly: signing out waits for it. Unfetched, the device is dropped after
  // 30 days anyway, and its token is gone from here.
  if (current)
    await fetch(`${current.api}/api/desktop-notifications`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${current.token}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  return current?.deviceId
}

/** Fetches while turned on: at launch, and once turned on. */
export function start() {
  stop()
  if (!device()) return
  void fetchNow()
  timer = setInterval(() => void fetchNow(), EVERY_MS)
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = undefined
  generation++
  inFlight?.abort()
  inFlight = undefined
}

/** One fetch: what the API queued, shown. The API no longer knowing the device turns it off. */
export async function fetchNow() {
  const current = device()
  if (!current || polling === generation) return
  const mine = generation
  polling = mine
  const abort = new AbortController()
  inFlight = abort
  try {
    const response = await fetch(`${current.api}/api/desktop-notifications`, {
      headers: { authorization: `Bearer ${current.token}` },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    })
    // Turned off, signed out or turned on again meanwhile: this answer is no one's now.
    if (mine !== generation) return
    if (response.status === 401) {
      // Removed elsewhere (turned off in another window, or the person signed out).
      if (device()?.deviceId === current.deviceId) store(undefined)
      return stop()
    }
    if (!response.ok) return
    const { messages } = (await response.json()) as { messages?: PushMessage[] }
    if (mine !== generation) return
    for (const message of messages ?? []) show(message)
  } catch {
    // Offline or asleep: the next fetch tries again; the API keeps what is queued a while.
  } finally {
    if (polling === mine) polling = undefined
    if (inFlight === abort) inFlight = undefined
  }
}

/** Where a notification's click goes: its path on the dashboard's site, nowhere else. */
export function target(url: string) {
  try {
    const home = new URL(dashboard())
    const to = new URL(url, home.origin)
    return to.origin === home.origin ? to.toString() : dashboard()
  } catch {
    return dashboard()
  }
}

export function show(message: PushMessage) {
  for (const tag of message.close ?? []) {
    shown.get(tag)?.close()
    shown.delete(tag)
  }
  if (typeof message.badge === 'number')
    setBadge(Number.isInteger(message.badge) && message.badge > 0 ? message.badge : 0)
  if (!supported() || typeof message.title !== 'string') return
  shown.get(message.tag)?.close()
  const notification = new Notification({
    title: message.title,
    body: typeof message.body === 'string' ? message.body : '',
  })
  notification.on('click', () => {
    shown.delete(message.tag)
    showDashboard(target(String(message.url ?? '/app')))
  })
  notification.on('close', () => {
    if (shown.get(message.tag) === notification) shown.delete(message.tag)
  })
  notification.show()
  shown.set(message.tag, notification)
}
