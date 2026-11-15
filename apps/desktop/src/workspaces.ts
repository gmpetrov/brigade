// The workspaces this computer is linked to, one runner home each, and the one it runs for.
//
// A runner keeps a workspace's own state in its home: runner.json (its link), the library
// mirror, the outbox of events not yet sent, thread folders. So each workspace gets a home of
// its own and switching never mixes them: the first one linked keeps ~/.brigade itself, the
// others live in ~/.brigade/workspaces/<key>. They share the runner install (bin/, node/,
// runner/) in ~/.brigade, and one runner runs at a time, for the workspace named in
// ~/.brigade/active-workspace. The same layout as the Tauri app before this one.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './settings.js'

/** The key of ~/.brigade itself. */
export const BASE = ''

export type Linked = {
  /** BASE, or its folder's name in ~/.brigade/workspaces. */
  key: string
  name: string
  id?: string
  api: string
}

const homesDir = (base: string) => join(base, 'workspaces')
const activeFile = (base: string) => join(base, 'active-workspace')

/** A key names a folder of workspaces/, nothing else: no path, no dots. */
export const validKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key)

export const homeIn = (base: string, key: string) =>
  key === BASE ? base : join(homesDir(base), key)

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The workspace a home is linked to, from its runner's config. */
export function readLink(base: string, key: string): Linked | undefined {
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(join(homeIn(base, key), 'runner.json'), 'utf8'))
  } catch {
    return undefined
  }
  const name = config.workspaceName
  const api = config.apiUrl
  if (typeof name !== 'string' || typeof api !== 'string') return undefined
  // Older runners linked without it; their token starts with it (`<workspaceId>.<secret>`).
  let id = typeof config.workspaceId === 'string' ? config.workspaceId : undefined
  if (id === undefined && typeof config.token === 'string') {
    const dot = config.token.indexOf('.')
    if (dot > 0) id = config.token.slice(0, dot)
  }
  return { key, name, api: api.replace(/\/+$/, ''), ...(id !== undefined && { id }) }
}

export function allIn(base: string): Linked[] {
  const linked: Linked[] = []
  const first = readLink(base, BASE)
  if (first) linked.push(first)
  let keys: string[] = []
  try {
    keys = readdirSync(homesDir(base))
  } catch {}
  const others = keys
    .filter(validKey)
    .map((key) => readLink(base, key))
    .filter((w): w is Linked => !!w)
    .sort((a, b) => {
      const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()]
      return x < y ? -1 : x > y ? 1 : 0
    })
  return [...linked, ...others]
}

export function activeIn(base: string) {
  let key = ''
  try {
    key = readFileSync(activeFile(base), 'utf8').trim()
  } catch {}
  // A home since removed by hand: back to ~/.brigade.
  return validKey(key) && isDir(join(homesDir(base), key)) ? key : BASE
}

export function setActiveIn(base: string, key: string) {
  try {
    mkdirSync(base, { recursive: true })
    writeFileSync(activeFile(base), key)
  } catch {}
}

/**
 * Where a link to the workspace `id` (when the link names it) on `api` goes, and whether that
 * home is new: the workspace's own home when it is linked here already, so linking it again
 * keeps its computer; without an id (a link from an older API), the active home; ~/.brigade
 * while that is linked to nothing; else a new home, made empty here. A new home that ends up
 * not linked is the caller's to remove.
 */
export function homeForLinkIn(
  base: string,
  id: string | undefined,
  api: string,
  now = () => Math.floor(Date.now() / 1000),
): { key: string; created: boolean } {
  const trimmed = api.replace(/\/+$/, '')
  if (id !== undefined) {
    const found = allIn(base).find((w) => w.id === id && w.api === trimmed)
    if (found) return { key: found.key, created: false }
  }
  if (id === undefined) return { key: activeIn(base), created: false }
  if (!readLink(base, BASE)) return { key: BASE, created: false }
  const stamp = now()
  for (let n = 0; ; n++) {
    const key = n === 0 ? `w${stamp}` : `w${stamp}-${n}`
    // Made here, so two links at once never pick the same new home.
    try {
      mkdirSync(homesDir(base), { recursive: true })
      mkdirSync(join(homesDir(base), key))
      return { key, created: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      // Not made: the link fails there, and nothing else is written.
      return { key, created: true }
    }
  }
}

export const all = () => allIn(home())
/** The key of the workspace the runner runs for. */
export const active = () => activeIn(home())
export const setActive = (key: string) => setActiveIn(home(), key)
/** The runner home of a workspace. */
export const homeOf = (key: string) => homeIn(home(), key)
export const homeForLink = (id: string | undefined, api: string) => homeForLinkIn(home(), id, api)
