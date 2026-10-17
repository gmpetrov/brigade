// A repository's own settings for Brigade, committed in its .brigade/ folder as
// Conductor's .conductor/ and Orca's orca.yaml are: each branch has its own,
// changed in the pull request whose code needs it, and people review what
// Brigade runs on their computer as they review code.
//   .brigade/settings.toml        the team's: how the preview starts ([preview])
//   .brigade/settings.local.toml  one person's, ignored by git: over the team's
// The recipe saved in Brigade stays: for a branch without the file, for a
// repository whose people want none of Brigade's files, and for the vault
// credentials, which are the workspace's, not the repository's.
//
// On a member's machine, .worktreeinclude (which Conductor and Orca read too)
// lists files git ignores, such as .env, that a checkout gets from the
// member's own clone of the repository: the app has the settings it has there.
import { constants } from 'node:fs'
import { appendFile, cp, lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { PreviewRecipe } from '@brigade/contracts'
import { CLOUD, HOME } from './config.js'
import { run } from './repos.js'

export const SETTINGS = '.brigade/settings.toml'
export const LOCAL_SETTINGS = '.brigade/settings.local.toml'
export const INCLUDE = '.worktreeinclude'
/** Where a checkout notes the files it got from the member's clone: never packed for another computer. */
export const COPIED = 'brigade-copied'

/** [preview]'s keys, as people write them, and the recipe's field for each. */
const KEYS = {
  setup: 'setup',
  command: 'command',
  cwd: 'cwd',
  port: 'port',
  ports: 'ports',
  env: 'env',
  env_file: 'envFile',
  pages: 'paths',
  timeout: 'timeoutSeconds',
  archive: 'archive',
} as const satisfies Record<string, keyof PreviewRecipe>

const HEADER =
  "# How Brigade starts this repository's preview, on this branch: setup, then command, in cwd;\n" +
  '# archive frees what setup made outside the checkout once the thread goes quiet. Secrets are\n' +
  "# not here: they are the repository's preview variables in Brigade. One person's changes go in\n" +
  '# .brigade/settings.local.toml, which git ignores.\n'

/** What a checkout's settings say of its preview: none, a recipe, or why they could not be read. */
export type RepoPreview =
  | { found: false }
  | { found: true; recipe: PreviewRecipe; files: string[] }
  | { found: true; error: string; files: string[] }

/** owner/name from a remote URL: GitHub's, or the API's git proxy, which ends the same way. */
export function repositoryFromRemote(url: string) {
  const match = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/** A file's text as the teammate's user (or the runner's on a member's machine); null when there is none. */
export async function readText(path: string, runAs?: string): Promise<string | null> {
  if (!runAs)
    return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(error),
    )
  return run('sh', ['-c', '[ -f "$1" ] || exit 3; cat -- "$1"', 'sh', path], { runAs }).then(
    (out) => out.toString('utf8'),
    (error: { code?: number }) => (error.code === 3 ? null : Promise.reject(error)),
  )
}

/** Write a file in a checkout, never through a link: a branch could point one anywhere. */
async function writeText(path: string, text: string, runAs?: string) {
  await run(
    'sh',
    [
      '-c',
      'd=$(dirname -- "$1"); if [ -L "$d" ] || [ -L "$1" ]; then echo "$1 goes through a link" >&2; exit 1; fi; ' +
        'mkdir -p -- "$d" && cat > "$1"',
      'sh',
      path,
    ],
    { runAs, input: Buffer.from(text) },
  )
}

/** The preview a checkout's .brigade/ settings describe, the person's own over the team's. */
export async function readRepoPreview(checkout: string, runAs?: string): Promise<RepoPreview> {
  const texts = await Promise.all(
    [SETTINGS, LOCAL_SETTINGS].map(async (file) => ({
      file,
      text: await readText(join(checkout, file), runAs),
    })),
  )
  const present = texts.filter((t): t is { file: string; text: string } => t.text !== null)
  const files = present.map((t) => t.file)
  try {
    const recipe = recipeOf(present)
    return recipe ? { found: true, files, recipe } : { found: false }
  } catch (error) {
    return { found: true, files, error: message(error) }
  }
}

/** The recipe settings files describe, each over the one before; null when none has [preview]. */
function recipeOf(texts: { file: string; text: string }[]): PreviewRecipe | null {
  const merged: Record<string, unknown> = {}
  let any = false
  for (const { file, text } of texts) {
    let table: unknown
    try {
      table = (parse(text) as Record<string, unknown>).preview
    } catch (error) {
      throw new Error(`${file} is not valid TOML: ${message(error)}`)
    }
    if (table === undefined) continue
    if (!isTable(table)) throw new Error(`[preview] in ${file} is not a table`)
    const unknown = Object.keys(table).filter((key) => !(key in KEYS))
    if (unknown.length)
      throw new Error(
        `${file}: [preview] has no ${unknown.join(', ')} (it takes ${Object.keys(KEYS).join(', ')})`,
      )
    any = true
    for (const [key, value] of Object.entries(table)) {
      const field = KEYS[key as keyof typeof KEYS]
      merged[field] =
        field === 'env' && isTable(value) && isTable(merged.env)
          ? { ...merged.env, ...value }
          : value
    }
  }
  if (!any) return null
  const parsed = PreviewRecipe.safeParse(merged)
  if (!parsed.success)
    throw new Error(
      `${texts.map((t) => t.file).join(' and ')}: ${parsed.error.issues
        .map((issue) => `${tomlPath(issue.path)}: ${issue.message}`)
        .join('; ')}`,
    )
  return parsed.data
}

/**
 * Write the recipe as the checkout's .brigade/settings.toml, keeping the
 * file's other tables, and have git ignore the personal file beside it.
 * Left alone when it already says the same. `local`: the checkout also has a
 * person's settings, which were part of the start saved.
 */
export async function writeRepoPreview(checkout: string, recipe: PreviewRecipe, runAs?: string) {
  const path = join(checkout, SETTINGS)
  const before = await readText(path, runAs)
  const local = (await readText(join(checkout, LOCAL_SETTINGS), runAs)) !== null
  let saved: PreviewRecipe | null = null
  try {
    saved = before === null ? null : recipeOf([{ file: SETTINGS, text: before }])
  } catch {
    // Replaced.
  }
  if (saved && sameStart(saved, recipe)) return { file: SETTINGS, changed: false, local }
  await writeText(path, settingsText(recipe, before), runAs)
  const ignore = join(checkout, '.brigade', '.gitignore')
  if ((await readText(ignore, runAs)) === null)
    await writeText(ignore, '/settings.local.toml\n', runAs)
  return { file: SETTINGS, changed: true, local }
}

/** Whether two recipes start the preview the same way, as the file says it. */
export function sameStart(a: PreviewRecipe, b: PreviewRecipe) {
  const shape = (r: PreviewRecipe) =>
    JSON.stringify(
      Object.values(KEYS).map((field) => {
        const value = r[field]
        return typeof value === 'string' ? value.trimEnd() : (value ?? null)
      }),
    )
  return shape(a) === shape(b)
}

/** .brigade/settings.toml for a recipe: its [preview], after the file's other tables. */
export function settingsText(recipe: PreviewRecipe, existing: string | null): string {
  let rest = ''
  if (existing) {
    try {
      const others = parse(existing) as Record<string, unknown>
      delete others.preview
      if (Object.keys(others).length) rest = `${stringify(others)}\n\n`
    } catch {
      // Not TOML: replaced whole.
    }
  }
  const lines = ['[preview]']
  const line = (key: string, value: string | number | (string | number)[] | undefined) => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return
    lines.push(`${key} = ${tomlValue(value)}`)
  }
  line('setup', recipe.setup?.trim() ? recipe.setup : undefined)
  line('command', recipe.command)
  line('cwd', recipe.cwd)
  line('port', recipe.port)
  line('ports', recipe.ports)
  line('env_file', recipe.envFile)
  line('pages', recipe.paths)
  line('timeout', recipe.timeoutSeconds)
  line('archive', recipe.archive?.trim() ? recipe.archive : undefined)
  const env = Object.entries(recipe.env)
  if (env.length) {
    lines.push('', '[preview.env]')
    for (const [name, value] of env) lines.push(`${name} = ${tomlValue(value)}`)
  }
  return `${HEADER}\n${rest}${lines.join('\n')}\n`
}

/** A value in TOML: a script over several lines as it reads, unescaped. */
function tomlValue(value: string | number | (string | number)[]): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (typeof value === 'number') return String(value)
  // A literal string takes everything but control characters, as is; a newline right after ''' is dropped.
  if (value.includes('\n') && !value.includes("'''") && !/[\0-\x08\x0b-\x1f\x7f]/.test(value))
    return `'''\n${value.endsWith('\n') ? value : `${value}\n`}'''`
  return JSON.stringify(value).replace(/\x7f/g, '\\u007f')
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A recipe field's path, as the TOML key people wrote. */
function tomlPath(path: PropertyKey[]) {
  const [field, ...rest] = path
  const key = Object.entries(KEYS).find(([, f]) => f === field)?.[0] ?? String(field)
  return ['preview', key, ...rest.map(String)].join('.')
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Setups made for other tools that a teammate can start from: those the checkout has. */
export async function otherSetups(checkout: string, runAs?: string) {
  const candidates = [
    'orca.yaml',
    '.conductor/settings.toml',
    'conductor.json',
    '.devcontainer/devcontainer.json',
    '.gitpod.yml',
  ]
  const found = await Promise.all(
    candidates.map(async (file) =>
      (await readText(join(checkout, file), runAs).catch(() => null)) === null ? null : file,
    ),
  )
  return found.filter((file): file is string => file !== null)
}

/** The paths a .worktreeinclude lists: literal, inside the repository, never in .git. */
export function includedPaths(text: string): string[] {
  const paths = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[]/.test(line)) continue
    const path = line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) continue
    const segments = path.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s === '.git')) continue
    paths.add(path)
    if (paths.size >= 1000) break
  }
  return [...paths]
}

/** Copied from the member's clone into one checkout, at most: beyond, an entry is left out. */
const INCLUDE_MAX_BYTES = 1024 ** 3
const INCLUDE_MAX_ENTRIES = 20_000

/**
 * On a member's machine: copy into the checkout what its .worktreeinclude
 * (or the member's clone's) lists, from the member's own clone, where git
 * ignores it there and the checkout lacks it. Returns what was copied.
 */
export async function copyIncluded(checkout: string, repository: string): Promise<string[]> {
  if (CLOUD) return []
  const clone = await memberClone(repository)
  if (!clone || resolve(clone) === resolve(checkout)) return []
  const list = (await readText(join(checkout, INCLUDE))) ?? (await readText(join(clone, INCLUDE)))
  if (!list) return []
  const missing: string[] = []
  for (const path of includedPaths(list))
    if (
      !(await exists(join(checkout, path))) &&
      (await exists(join(clone, path))) &&
      // Through a link on either side, a copy could land or come from anywhere.
      !(await throughLink(checkout, path)) &&
      !(await throughLink(clone, path))
    )
      missing.push(path)
  if (missing.length === 0) return []
  // Only what git ignores there: a tracked file comes with the checkout already.
  const ignored = new Set(
    (
      await run('git', ['-C', clone, 'check-ignore', '--', ...missing]).catch(
        (error: { stdout?: Buffer }) => error.stdout ?? Buffer.alloc(0),
      )
    )
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const copied: string[] = []
  let bytes = 0
  let entries = 0
  for (const path of missing.filter((p) => ignored.has(p))) {
    const size = await measure(join(clone, path), INCLUDE_MAX_ENTRIES - entries)
    if (!size || bytes + size.bytes > INCLUDE_MAX_BYTES) {
      console.warn(`left ${path} of ${repository} out of ${checkout}: too large to copy`)
      continue
    }
    // A clone of the file on APFS: no room taken until either side changes.
    await cp(join(clone, path), join(checkout, path), {
      recursive: true,
      force: false,
      errorOnExist: false,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    })
    bytes += size.bytes
    entries += size.entries
    copied.push(path)
  }
  if (copied.length) {
    const gitDir = join(checkout, '.git')
    if ((await stat(gitDir).catch(() => null))?.isDirectory())
      await appendFile(join(gitDir, COPIED), copied.map((p) => `${p}\n`).join(''))
    console.log(`copied ${copied.join(', ')} of ${repository} from ${clone} into ${checkout}`)
  }
  return copied
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

/** Whether a folder on the way to `path` under `base` is a link. */
async function throughLink(base: string, path: string) {
  const segments = path.split('/').slice(0, -1)
  for (let i = 1; i <= segments.length; i++) {
    const s = await lstat(join(base, ...segments.slice(0, i))).catch(() => null)
    if (!s) return false
    if (s.isSymbolicLink()) return true
  }
  return false
}

/** A file's or folder's size and entries, or null past `maxEntries`. */
async function measure(path: string, maxEntries: number) {
  let bytes = 0
  let entries = 0
  const walk = async (p: string): Promise<boolean> => {
    if (++entries > maxEntries) return false
    const s = await lstat(p)
    if (!s.isDirectory()) {
      bytes += s.size
      return true
    }
    for (const entry of await readdir(p)) if (!(await walk(join(p, entry)))) return false
    return true
  }
  return (await walk(path)) ? { bytes, entries } : null
}

/** Folders of a home a clone is never looked for in: macOS asks the member before anything reads them. */
const PRIVATE = new Set([
  'Applications',
  'Desktop',
  'Documents',
  'Downloads',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  'node_modules',
])
/** How deep under the home a clone is looked for (~/code/acme/web), and how many folders at most. */
const CLONE_DEPTH = 3
const CLONE_SCAN_MAX = 5000
/** A repository not found is looked for again after this. */
const CLONE_RESCAN_MS = 10 * 60_000

let scan: { at: number; clones: Map<string, string> } | undefined

/**
 * The member's own clone of a repository on their machine: the one named in
 * ~/.brigade/clones.json ({ "owner/name": "/path" }), else the first found
 * under their home folder, outside the folders macOS keeps private. Null when
 * there is none.
 */
export async function memberClone(repository: string, home = homedir()): Promise<string | null> {
  const wanted = repository
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
  const named = await readFile(join(HOME, 'clones.json'), 'utf8').then(
    (text) => (JSON.parse(text) as Record<string, unknown>)[wanted],
    () => undefined,
  )
  if (typeof named === 'string' && (await originOf(named)) === wanted) return named
  const fresh = scan && Date.now() - scan.at < CLONE_RESCAN_MS
  const known = scan?.clones.get(wanted)
  if (known && (await originOf(known)) === wanted) return known
  if (fresh) return null
  scan = { at: Date.now(), clones: await findClones(home) }
  return scan.clones.get(wanted) ?? null
}

/** Every clone under the home folder, by repository: the shallowest first. */
export async function findClones(home: string) {
  const clones = new Map<string, string>()
  let visited = 0
  let level = [home]
  for (let depth = 1; depth <= CLONE_DEPTH && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (depth === 1 && PRIVATE.has(entry.name)) continue
        if (entry.name === 'node_modules' || ++visited > CLONE_SCAN_MAX) continue
        const path = join(dir, entry.name)
        const repository = await originOf(path)
        if (repository) {
          if (!clones.has(repository)) clones.set(repository, path)
        } else next.push(path)
      }
    }
    level = next
  }
  return clones
}

/** The repository a folder is a clone of (its own .git folder, not a worktree's), from origin. */
async function originOf(dir: string) {
  const config = await readFile(join(dir, '.git', 'config'), 'utf8').catch(() => null)
  if (!config) return null
  const origin = /\[remote "origin"\]([^[]*)/.exec(config)?.[1]
  const url = origin && /^\s*url\s*=\s*(.+)$/m.exec(origin)?.[1]
  return url ? repositoryFromRemote(url) : null
}
