import { designFolderOf, type LibraryFile } from '@brigade/contracts'

// What a folder of an open document's path offers in its menu (DocumentPath): the folders and
// files in it, or, while a filter is typed, the files anywhere under it whose name matches.

export type FolderMenuEntry =
  | { kind: 'folder'; path: string; name: string }
  | { kind: 'design'; path: string; name: string }
  | { kind: 'file'; file: LibraryFile; name: string }

/** At most this many files match a filter; the rest are left out. */
export const FOLDER_MENU_MATCHES = 50

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

function fileEntry(file: LibraryFile, name: string): FolderMenuEntry {
  return { kind: 'file', file, name }
}

/**
 * The folders, then the files, right in `folder` ('' for the top), each by name. A design's
 * folder is one entry, opened as the design; what is in it is not listed.
 */
export function folderEntries(files: LibraryFile[], folder: string): FolderMenuEntry[] {
  const prefix = folder ? `${folder}/` : ''
  const folders = new Map<string, FolderMenuEntry>()
  const own: FolderMenuEntry[] = []
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    const rest = file.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) {
      own.push(fileEntry(file, rest))
      continue
    }
    const name = rest.slice(0, slash)
    const path = prefix + name
    if (folders.has(path)) continue
    folders.set(path, {
      kind: designFolderOf(path) === path ? 'design' : 'folder',
      path,
      name,
    })
  }
  return [...[...folders.values()].sort(byName), ...own.sort(byName)]
}

/**
 * The files anywhere under `folder` whose name holds `query` (any case), named by their path
 * from there: those whose name starts with it first. Files inside a design are left out.
 */
export function folderMatches(
  files: LibraryFile[],
  folder: string,
  query: string,
): FolderMenuEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return folderEntries(files, folder)
  const prefix = folder ? `${folder}/` : ''
  const starts: FolderMenuEntry[] = []
  const contains: FolderMenuEntry[] = []
  for (const file of files) {
    if (!file.path.startsWith(prefix) || designFolderOf(file.path)) continue
    const name = nameOf(file.path).toLowerCase()
    const at = name.indexOf(q)
    if (at < 0) continue
    ;(at === 0 ? starts : contains).push(fileEntry(file, file.path.slice(prefix.length)))
  }
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, FOLDER_MENU_MATCHES)
}

/** Each folder of a path, from the top: `a/b` gives `a` and `a/b`. */
export function pathFolders(folder: string) {
  const parts = folder.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
}

/**
 * What the document panel does when its path's menu goes to the library page, so that page
 * shows: on a wide screen it stays beside it, or goes back there when laid over the window
 * (`unexpand`); below that it covers the page, so it waits in its pill (`minimize`). Going
 * to the library by its query alone keeps the page's path, which minimizes it on its own
 * only when the path changes (SidePanel's onPageChange).
 */
export function makeRoom(wide: boolean, full: boolean): 'none' | 'unexpand' | 'minimize' {
  if (!wide) return 'minimize'
  return full ? 'unexpand' : 'none'
}
