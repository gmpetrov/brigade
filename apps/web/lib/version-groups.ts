// A library file's history folds a run of saves by the same person (or the
// same teammate in the same thread) close together in time into one group,
// so a long session of edits reads as one line rather than twenty.
import type { LibraryVersion } from '@brigade/contracts'

/** Saves further apart than this start a new group. */
export const GROUP_GAP_MS = 30 * 60 * 1000

export type VersionGroup = {
  /** Newest first, as the history lists them; never empty. */
  versions: [LibraryVersion, ...LibraryVersion[]]
  /** The version just before the group's oldest, which its changes are measured from. */
  before?: LibraryVersion
}

const who = (v: LibraryVersion) => `${v.by.type}:${v.by.id}:${v.by.sessionId ?? ''}`

/** Groups `versions` (newest first) into runs of saves by one author, kept in order. */
export function groupVersions(versions: LibraryVersion[]): VersionGroup[] {
  const groups: VersionGroup[] = []
  let run: LibraryVersion[] = []
  const close = (before?: LibraryVersion) => {
    const [head, ...rest] = run
    if (head) groups.push({ versions: [head, ...rest], before })
    run = []
  }
  for (const v of versions) {
    const newer = run.at(-1)
    const joins =
      newer &&
      who(newer) === who(v) &&
      // A restore stands on its own: it is the line someone looks for.
      !newer.restoredFromId &&
      !v.restoredFromId &&
      new Date(newer.createdAt).getTime() - new Date(v.updatedAt).getTime() <= GROUP_GAP_MS
    if (newer && !joins) close(v)
    run.push(v)
  }
  close()
  return groups
}
