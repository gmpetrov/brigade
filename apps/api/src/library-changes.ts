// Whether a teammate may move or delete something in the library. It needs to
// save to every file it changes, where it is and where it goes. A folder that
// holds access rules or is a project's folder stays where people put it.
import { inFolder, type FolderAccess } from '@brigade/contracts'

export type LibraryChange = {
  /** The file, or the folder. */
  path: string
  /** Where it goes; none to delete it. */
  to?: string
  /** For a folder: every file in it. */
  files: string[]
  /** Folders at or below it with access rules. */
  ruled: string[]
  /** Projects whose folder is at or below it. */
  projects: { name: string; folder: string }[]
}

const movedTo = (path: string, from: string, to: string) => to + path.slice(from.length)

/** Why the teammate may not make the change, or null. */
export function libraryChangeRefusal(
  teammate: string,
  access: (path: string) => FolderAccess,
  change: LibraryChange,
): string | null {
  const { path, to } = change
  const verb = to === undefined ? 'delete' : 'move'
  if (to !== undefined && to !== path && inFolder(to, path))
    return `${path} cannot go inside itself.`
  // Said of the folder itself, or of the one inside it that holds it back.
  const held = (folder: string, why: string) =>
    `${folder === path ? path : `${path} holds ${folder}, which`} ${why}: only a person can ${verb} ${folder === path ? 'it' : path}, from the library.`
  const project = change.projects[0]
  if (project) return held(project.folder, `is the folder of the project ${project.name}`)
  if (change.ruled.length) return held(change.ruled[0]!, 'has access rules for teammates')
  const paths = change.files.length ? change.files : [path]
  const touched = to === undefined ? paths : [...paths, ...paths.map((p) => movedTo(p, path, to))]
  const blocked = touched.find((p) => access(p) !== 'read_write')
  if (!blocked) return null
  return access(blocked) === 'none'
    ? `${teammate} has no access to that folder of the library.`
    : `${teammate} may read ${blocked} but not change it. An admin can allow it in the library or on the teammate's page.`
}
