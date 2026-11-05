// Following a thread's end (components/thread-conversation.tsx): what comes in glides into view,
// and the person scrolling always wins over it.

/** Keys that move the view up, away from the end. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/** Whether a person's input moves the view up, away from the thread's end: it stops following. */
export function leavesEnd(input: { type: string; deltaY?: number; key?: string }) {
  if (input.type === 'wheel') return (input.deltaY ?? 0) < 0
  if (input.type === 'keydown') return UP_KEYS.has(input.key ?? '')
  return false
}

/**
 * When the thread may glide to its end on its own: undefined once the person left it; otherwise
 * in how many ms, 0 for now. Within `quietMs` of their own input their scroll decides, and what
 * came meanwhile is followed once that is over (nothing else may come to follow it then).
 */
export function followIn(following: boolean, now: number, theirsAt: number, quietMs: number) {
  if (!following) return undefined
  return Math.max(0, theirsAt + quietMs - now)
}

/**
 * Whether the way to the end is glided rather than jumped: what came in is short (under a
 * screen away), and the thread was in already. A thread opening, or its pages coming in after
 * it opened, jumps there: gliding over all of it would scroll the whole thread before the eyes.
 */
export function glides(distance: number, viewport: number, settled: boolean) {
  return settled && distance <= viewport
}

/** How fast the view catches up with the end it follows: what is left halves every ~70 ms. */
const CHASE_S = 0.1

/**
 * How far to move the view down in `dt` seconds toward an end `distance` px below: a share of
 * the way that does not depend on the frame rate, at least a pixel, 0 once there. Called each
 * frame, it eases the view along with text growing beneath it, without starts and stops.
 */
export function chaseStep(distance: number, dt: number) {
  if (distance <= 0.5) return 0
  const share = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) / CHASE_S)
  return Math.min(distance, Math.max(1, distance * share))
}

/** The scroll box followed: the thread's conversation. */
export type FollowView = {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** Time and frames, the browser's in the thread, made up in tests. */
export type FollowClock = {
  now(): number
  frame(run: (now: number) => void): number
  cancelFrame(id: number): void
  after(run: () => void, ms: number): ReturnType<typeof setTimeout>
  cancel(handle: ReturnType<typeof setTimeout> | undefined): void
}

/**
 * Following a thread's end, all in one place: whether it follows, the frame loop easing the view
 * down to the end (chaseStep), and the person's own scrolling, which always wins. The view at the
 * end follows what comes in; the person scrolling up, or going to an earlier message, leaves it
 * until they come back down or ask for the end.
 */
export class EndFollower {
  /** Follows what comes in at the end. */
  following = true
  /** On its own way to the end: where the view is meanwhile says nothing of the person. */
  private moving = false
  /** The thread was in once: what comes at its end eases in rather than jumping there. */
  private settled = false
  private theirsAt = -Infinity
  private chase: number | undefined
  private later: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly view: () => FollowView | null,
    private readonly clock: FollowClock,
    /** Whether the view is at the end, for the button back to it. */
    private readonly atEnd: (at: boolean) => void,
    private readonly slack = 48,
    private readonly quietMs = 600,
  ) {}

  private distance(view: FollowView) {
    return view.scrollHeight - view.clientHeight - view.scrollTop
  }

  private stop() {
    if (this.chase !== undefined) this.clock.cancelFrame(this.chase)
    this.chase = undefined
    this.moving = false
  }

  /** The view scrolled: unless on its own way to the end, where it is says whether it follows. */
  measure() {
    const view = this.view()
    if (!view || this.moving) return
    this.following = this.distance(view) < this.slack
    this.atEnd(this.following)
  }

  /** The person's wheel, touch or keys: what moves stops where it is; up, they leave the end. */
  theirs(input: { type: string; deltaY?: number; key?: string }) {
    this.theirsAt = this.clock.now()
    this.stop()
    if (leavesEnd(input)) this.leave()
  }

  /** Away from the end on purpose (up, or to an earlier message): nothing pulls the view back. */
  leave() {
    this.stop()
    this.clock.cancel(this.later)
    this.following = false
    this.atEnd(false)
  }

  /** Once the thread is in, what comes at its end eases in. */
  settle(settled: boolean) {
    this.settled = settled
  }

  /** To the end, asked for (the button back, a message sent): eased there, or at once. */
  toEnd(eased: boolean) {
    this.following = true
    const view = this.view()
    if (!view) return
    if (eased) return this.ease()
    this.stop()
    view.scrollTop = view.scrollHeight
    this.atEnd(true)
  }

  /**
   * Something came in at the end or grew there: followed while following. Eased in when it is
   * under a screen away and the thread was in already; farther (a thread opening, its pages
   * coming in) at once. Within the quiet time after the person's input, once it is over.
   */
  follow() {
    const wait = followIn(this.following, this.clock.now(), this.theirsAt, this.quietMs)
    if (wait === undefined) return
    this.clock.cancel(this.later)
    if (wait > 0) {
      this.later = this.clock.after(() => this.follow(), wait)
      return
    }
    const view = this.view()
    if (!view) return
    this.toEnd(glides(this.distance(view), view.clientHeight, this.settled))
  }

  /** The frame loop easing the view down to the end while it moves on; it stops once there. */
  private ease() {
    this.moving = true
    if (this.chase !== undefined) return
    let last = this.clock.now()
    const frame = (now: number) => {
      this.chase = undefined
      const view = this.view()
      if (!view || !this.moving || !this.following) return void (this.moving = false)
      const step = chaseStep(this.distance(view), (now - last) / 1000)
      last = now
      if (step === 0) {
        // The last fraction of a pixel, then where it is is read again (the button back goes).
        view.scrollTop = view.scrollHeight
        this.moving = false
        return this.measure()
      }
      view.scrollTop += step
      this.chase = this.clock.frame(frame)
    }
    this.chase = this.clock.frame(frame)
  }

  dispose() {
    this.stop()
    this.clock.cancel(this.later)
  }
}
