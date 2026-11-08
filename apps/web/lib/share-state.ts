// What a file's bar knows of its public link (components/share-button.tsx), kept apart from React
// so its rules are tested (test/share-state.test.ts). Replies come back late and out of order:
// one about a file no longer shown, or older than one applied, changes nothing. A change (turning
// the link on or off) is numbered as its reply lands, so a read that started before it never
// undoes it, and the file is read again once the change landed (or failed).
import type { LibraryShare } from '@brigade/contracts'

/** The link of the file the bar knew last, from the reply numbered `seq`. */
export type ShareState = { documentId: string; share: LibraryShare | null; seq: number } | null

/** A reply about `documentId`'s link, numbered `seq`. */
export type ShareReply = { documentId: string; share: LibraryShare | null; seq: number }

/** The state once a reply comes back while the bar shows `shown`. */
export function afterReply(state: ShareState, shown: string | null, reply: ShareReply): ShareState {
  if (reply.documentId !== shown) return state
  if (state && state.documentId === shown && state.seq > reply.seq) return state
  return reply
}

/** The link the bar shows for `shown`: undefined until a reply about it came back. */
export const shownShare = (state: ShareState, shown: string | null | undefined) =>
  state && shown && state.documentId === shown ? state.share : undefined

/** The API, as the bar asks it: a file's link (GET), or turning it on (POST) or off (DELETE). */
export type AskShare = (
  documentId: string,
  method: 'GET' | 'POST' | 'DELETE',
) => Promise<LibraryShare | null>

/** One bar's link: of the file it shows, read, refreshed and changed. */
export class ShareLinks {
  private state: ShareState = null
  private shown: string | null = null
  private seq = 0
  private listeners = new Set<() => void>()

  constructor(private readonly ask: AskShare) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /**
   * `documentId`'s link as last known: undefined until a reply about it came back, null for none.
   * Asked with the file the bar renders, which may be newer than the one it was last shown.
   */
  shareOf(documentId: string | null) {
    return shownShare(this.state, documentId)
  }

  /** The bar shows another file (or none): read its link. */
  show(documentId: string | null) {
    if (documentId === this.shown) return
    this.shown = documentId
    this.emit()
    if (documentId) void this.read(documentId)
  }

  /** Read the shown file's link again: the library changed, or the dashboard's socket is back. */
  refresh() {
    if (this.shown) void this.read(this.shown)
  }

  /** Turn a file's link on or off; its reply is the file's link now. */
  async toggle(documentId: string, on: boolean) {
    try {
      const share = await this.ask(documentId, on ? 'POST' : 'DELETE')
      // Numbered as it lands: newer than any read that started before.
      this.apply({ documentId, share, seq: ++this.seq })
      return share
    } finally {
      // What another member did meanwhile, or what a failed change left.
      if (this.shown === documentId) void this.read(documentId)
    }
  }

  private async read(documentId: string) {
    const seq = ++this.seq
    let share: LibraryShare | null
    try {
      share = await this.ask(documentId, 'GET')
    } catch {
      // Unreadable: shown as not shared, unless a reply already said otherwise.
      if (this.state?.documentId === documentId) return
      share = null
    }
    this.apply({ documentId, share, seq })
  }

  private apply(reply: ShareReply) {
    const next = afterReply(this.state, this.shown, reply)
    if (next === this.state) return
    this.state = next
    this.emit()
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

/** The switch in the bar's panel: the change always, then whoever wants to know (lists). */
export async function turnLink(
  toggle: (on: boolean) => Promise<LibraryShare | null>,
  on: boolean,
  onChange?: (shared: boolean) => void,
) {
  const share = await toggle(on)
  onChange?.(Boolean(share))
  return share
}
