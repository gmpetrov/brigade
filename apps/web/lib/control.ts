// Take control and hand back show at once. The API answers in about a second (it builds the
// thread's spec for the runner and keeps the command), so every view of the thread shows the
// member's change while it goes: the computer's toolbar, its panel, the hand back card and the
// composer, wherever they read the thread from. Undone if the API refuses it, with its error.
// Kept per thread while the dashboard is open.
import { useSyncExternalStore } from 'react'

type Controlled = { id: string; controlledByMemberId: string | null }

type Change = {
  /** Who has control once it is through: a member, or null when handed back. */
  to: string | null
  /** The API took it. */
  settled: boolean
  /**
   * The thread as each view had it while the change went: fetched before it was through, they
   * may say who had control before. Once it is through, a thread fetched since wins.
   */
  stale: WeakSet<object>
  /** Each stale thread shown with the change, the same object each time it renders. */
  shown: WeakMap<object, object>
}

const changes = new Map<string, Change>()
const errors = new Map<string, string>()
/** Each thread's request going now, the last asked: the next goes once it is through. */
const inFlight = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()

function changed() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Gives control to `to` (a member, or null to hand back) through `request`, shown at once. Throws
 * what the request threw, once every view is back to who had control before.
 *
 * One request at a time per thread: shown at once, the opposite button is there before the API
 * took the first, and a hand back sent while its takeover still goes could reach the runner first,
 * leaving it paused with nobody in control. So the next waits for the one before, and
 * useControlPending holds every button that changes control meanwhile.
 */
export async function changeControl(
  threadId: string,
  to: string | null,
  request: () => Promise<unknown>,
) {
  const change: Change = { to, settled: false, stale: new WeakSet(), shown: new WeakMap() }
  changes.set(threadId, change)
  errors.delete(threadId)
  try {
    await inControlOrder(threadId, request)
    change.settled = true
  } catch (e) {
    // A later change of this thread's is its own.
    if (changes.get(threadId) === change) {
      changes.delete(threadId)
      errors.set(threadId, (e as Error).message)
      changed()
    }
    throw e
  }
}

/**
 * A request that may change the thread's control without saying so (answering a ticket hands
 * back, src/decide.ts): sent once any change of control asked before it is through, and holding
 * the next ones meanwhile.
 */
export async function inControlOrder<T>(threadId: string, request: () => Promise<T>) {
  const going = (inFlight.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(request)
  inFlight.set(threadId, going)
  changed()
  try {
    return await going
  } finally {
    if (inFlight.get(threadId) === going) {
      inFlight.delete(threadId)
      changed()
    }
  }
}

/** The thread as the member's change of control shows it, the same object while nothing changes. */
function withControl<T extends Controlled>(thread: T, change: Change | undefined): T {
  if (!change) return thread
  if (!change.settled) change.stale.add(thread)
  else if (!change.stale.has(thread)) return thread
  if (thread.controlledByMemberId === change.to) return thread
  let shown = change.shown.get(thread) as T | undefined
  if (!shown) {
    shown = { ...thread, controlledByMemberId: change.to }
    change.shown.set(thread, shown)
  }
  return shown
}

/** The thread with the member's change of control in it, while it goes and until fetched again. */
export function useControlled<T extends Controlled>(thread: T): T
export function useControlled<T extends Controlled>(thread: T | undefined): T | undefined
export function useControlled<T extends Controlled>(thread: T | undefined) {
  const id = thread?.id
  const change = useSyncExternalStore(
    subscribe,
    () => (id ? changes.get(id) : undefined),
    () => undefined,
  )
  return thread && withControl(thread, change)
}

/** Why the last change of control of the thread failed, until the next one. */
export function useControlError(threadId: string) {
  return useSyncExternalStore(
    subscribe,
    () => errors.get(threadId),
    () => undefined,
  )
}

/** A change of the thread's control goes now: its buttons wait. */
export function useControlPending(threadId: string) {
  return useSyncExternalStore(
    subscribe,
    () => inFlight.has(threadId),
    () => false,
  )
}

/** Whether a change of the thread's control goes now, outside React. */
export function controlPending(threadId: string) {
  return inFlight.has(threadId)
}

/** The thread as its views show it now, outside React (useControlled in it). */
export function shownThread<T extends Controlled>(thread: T): T {
  return withControl(thread, changes.get(thread.id))
}
