// MCP servers' tool lists as an isolate keeps them between calls (src/mcp-tools.ts): bounded.
//
// A hub object runs its teammates' App calls, and each call needs its tool from the server's list.
// One list can weigh megabytes (PostHog's is about 2.7 MB of JSON), and every hub object of an
// isolate shares its modules, so this cache is the isolate's, under its 128 MB. Kept in a plain
// Map, an account's list stayed for as long as the isolate lived, past its time, after its last
// call: with every account any of its workspaces called, the isolate went over its memory and was
// reset, and its hubs' sockets and calls with it. So a list goes once its time is up, and the
// lists together keep under a size, the least recently used going first.

/** A list is used this long, then listed again: a server's new tools show within it. */
export const LIST_MS = 5 * 60_000
/** How much the lists may weigh together, in characters of their JSON. */
export const KEPT_CHARS = 4_000_000

type Kept<T> = { at: number; value: T; chars: number }

export class ToolLists<T = unknown> {
  private readonly lists = new Map<string, Kept<T>>()
  private chars = 0

  constructor(
    private readonly maxChars = KEPT_CHARS,
    private readonly ttlMs = LIST_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** A connection's list while it is fresh; one past its time is let go. */
  get(key: string): T | undefined {
    const kept = this.lists.get(key)
    if (!kept) return undefined
    if (this.now() - kept.at >= this.ttlMs) {
      this.delete(key)
      return undefined
    }
    // Used: the last to go.
    this.lists.delete(key)
    this.lists.set(key, kept)
    return kept.value
  }

  /**
   * Keep a connection's list, `chars` its JSON's length. Lists past their time go, then the least
   * recently used until all fit. One larger than the whole budget is not kept: listed at each call.
   */
  set(key: string, value: T, chars: number) {
    this.delete(key)
    this.sweep()
    if (chars > this.maxChars) return
    for (const [oldest] of this.lists) {
      if (this.chars + chars <= this.maxChars) break
      this.delete(oldest)
    }
    this.lists.set(key, { at: this.now(), value, chars })
    this.chars += chars
  }

  delete(key: string) {
    const kept = this.lists.get(key)
    if (!kept) return false
    this.lists.delete(key)
    this.chars -= kept.chars
    return true
  }

  /** Let go of every list past its time. */
  sweep() {
    const now = this.now()
    for (const [key, kept] of this.lists) if (now - kept.at >= this.ttlMs) this.delete(key)
  }

  /** How many lists, and how many characters, are kept: for tests and logs. */
  get size() {
    return { lists: this.lists.size, chars: this.chars }
  }
}
