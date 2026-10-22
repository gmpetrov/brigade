import type { LibraryFile } from '@brigade/contracts'

/** When each open library file was last written, as of the last look: by its id. */
export type Stamps = Map<string, string>

/**
 * The open library files a teammate changed since the last look, leaving out
 * the one in front, and `stamps` brought up to date. A file seen for the
 * first time only sets where it stands; files no longer open are forgotten.
 */
export function changedSince(
  stamps: Stamps,
  files: Pick<LibraryFile, 'id' | 'updatedAt' | 'updatedBy'>[],
  open: readonly string[],
  front: string | null,
): string[] {
  for (const id of [...stamps.keys()]) if (!open.includes(id)) stamps.delete(id)
  const changed: string[] = []
  for (const file of files) {
    if (!open.includes(file.id)) continue
    const before = stamps.get(file.id)
    stamps.set(file.id, file.updatedAt)
    const byTeammate = file.updatedBy?.type === 'teammate' || file.updatedBy?.type === 'runner'
    if (before && before !== file.updatedAt && file.id !== front && byTeammate)
      changed.push(file.id)
  }
  return changed
}
