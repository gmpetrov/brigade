// What a file's bar knows of its public link (components/share-button.tsx), kept apart from React
// so its rules are tested (test/share-state.test.ts). Replies come back late and out of order:
// one about a file no longer shown, or older than one already applied, changes nothing.
import type { LibraryShare } from '@brigade/contracts'

/** The link of the file the bar knew last, from the request numbered `seq`. */
export type ShareState = { documentId: string; share: LibraryShare | null; seq: number } | null

/** A reply about `documentId`'s link, to the request numbered `seq` (numbered as each starts). */
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
