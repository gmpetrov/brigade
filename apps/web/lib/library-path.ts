// The path typed in the library's "new file" and "new folder" form: the folders
// gone into (shown as chips), then the name being typed, with the folders that
// match it offered below.

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The existing folder spelled like `name` in `base` (any case), else `name` as typed. */
export function folderNamed(folders: string[], base: string, name: string) {
  const lower = name.toLowerCase()
  const found = folders.find((f) => parentOf(f) === base && nameOf(f).toLowerCase() === lower)
  return found ? nameOf(found) : name
}

/**
 * Typed or pasted text with slashes: everything before the last slash goes
 * into folders (spelled as the existing ones), the rest is the name still typed.
 */
export function splitTyped(folders: string[], segments: string[], typed: string) {
  if (!typed.includes('/')) return { segments, text: typed }
  const parts = typed.split('/')
  const text = parts.pop()!.trimStart()
  const next = [...segments]
  for (const part of parts.map((p) => p.trim()).filter(Boolean))
    next.push(folderNamed(folders, next.join('/'), part))
  return { segments: next, text }
}

/** The folders in `base` that match `text`: those starting with it first, then those containing it. */
export function folderSuggestions(folders: string[], base: string, text: string, max = 8) {
  const lower = text.trim().toLowerCase()
  const names = folders.filter((f) => parentOf(f) === base).map(nameOf)
  const starts = names.filter((n) => n.toLowerCase().startsWith(lower))
  const contains = names.filter(
    (n) => !n.toLowerCase().startsWith(lower) && n.toLowerCase().includes(lower),
  )
  const byName = (a: string, b: string) => a.localeCompare(b)
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, max)
}
