// The code panel's view of a teammate's working folder for a thread (thread.code):
// a folder's entries for its tree, files by name and lines by text for its filter,
// and open files' hashes, so the panel sees when the teammate changed one. Never
// outside the working folder, after resolving links; as the teammate's user on a
// cloud computer. `find`'s and `git grep`'s plain options only: Macs run it too.
import { basename, isAbsolute, join, relative } from 'node:path'
import {
  CODE_FIND_MAX,
  CODE_LIST_MAX,
  FILE_VIEW_MAX,
  type ApiToRunner,
  type CodeEntry,
  type RunnerToApi,
} from '@brigade/contracts'
import { asText, inside, parseGrep, readStart, real, SAFE_ID, sha256, workDir } from './files.js'
import { run } from './repos.js'

type Request = Extract<ApiToRunner, { type: 'thread.code' }>
type Result = Extract<RunnerToApi, { type: 'thread.code.result' }>

/** Folders a search by name skips: dependencies, git's own, builds and caches. */
const SKIPPED = [
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  '.venv',
  '__pycache__',
]
/** Files a search by name looks through at most. */
const FIND_SCAN_MAX = 30_000

/** Runs a shell script as the teammate, its output as text; what fails to read is left out. */
const sh = (script: string, args: string[], user: string | undefined) =>
  run('sh', ['-c', script, 'sh', ...args], { runAs: user, timeout: 15_000 }).then((out) =>
    out.toString('utf8'),
  )

/** Entries sorted as a tree shows them: folders first, then by name, case aside. */
export function sortEntries(entries: CodeEntry[]) {
  return entries.sort(
    (a, b) =>
      Number(b.dir) - Number(a.dir) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  )
}

/**
 * Files whose path holds every word of the query, case aside, best first: the name
 * starting with it, then holding it, then the path only; shorter paths first.
 */
export function matchFiles(paths: string[], query: string, max = CODE_FIND_MAX) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    if (!words.every((w) => lower.includes(w))) continue
    const name = basename(lower)
    const first = words[0]!
    const score = name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2
    scored.push({ path, score })
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    )
    .slice(0, max)
    .map((s) => s.path)
}

export async function codeFiles(request: Request): Promise<Result> {
  const base = { type: 'thread.code.result' as const, requestId: request.requestId }
  if (!SAFE_ID.test(request.sessionId) || !SAFE_ID.test(request.teammateId))
    return { ...base, ok: false, error: 'Invalid thread' }
  const { user, dir } = workDir(request.teammateId, request.sessionId)
  const own = await real(dir, user)
  if (!own) return { ...base, ok: false, error: 'not_found' }
  /** A path of the working folder, resolved; undefined when it is not one. */
  const resolve = async (path: string) => {
    if (isAbsolute(path)) return undefined
    const target = await real(join(own, path), user)
    return target && inside(own, target) ? target : undefined
  }
  try {
    switch (request.op) {
      case 'list': {
        const folder = await resolve(request.path ?? '')
        if (!folder) return { ...base, ok: false, error: 'not_found' }
        // -L: a link shows as what it leads to. Folders, a line no name can be, then the rest.
        const out = await sh(
          'find -L "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null; echo //; ' +
            'find -L "$1" -mindepth 1 -maxdepth 1 ! -type d 2>/dev/null; true',
          [folder],
          user,
        )
        const lines = out.split('\n')
        const split = lines.indexOf('//')
        const entries = sortEntries(
          lines
            .map((p, i) => ({ name: basename(p), dir: i < split }))
            .filter((e, i) => i !== split && e.name),
        )
        return {
          ...base,
          ok: true,
          entries: entries.slice(0, CODE_LIST_MAX),
          ...(entries.length > CODE_LIST_MAX ? { more: true } : {}),
        }
      }
      case 'find': {
        const query = request.query?.trim() ?? ''
        if (!query) return { ...base, ok: true, files: [] }
        const prune = SKIPPED.map((n) => `-name '${n}'`).join(' -o ')
        const out = await sh(
          `find "$1" \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${FIND_SCAN_MAX}; true`,
          [own],
          user,
        )
        const paths = out
          .split('\n')
          .filter(Boolean)
          .map((p) => relative(own, p))
          .filter((p) => p && !p.startsWith('..'))
        return { ...base, ok: true, files: matchFiles(paths, query) }
      }
      case 'grep': {
        const query = request.query?.trim() ?? ''
        if (!query) return { ...base, ok: true, matches: [] }
        const out = await run(
          'git',
          [
            '-C',
            own,
            'grep',
            '--no-index',
            '--exclude-standard',
            '-z',
            '-n',
            '-I',
            '-i',
            '-F',
          ].concat(['--max-count=5', '-e', query]),
          { runAs: user, timeout: 15_000 },
        ).then(
          (b) => b.toString('utf8'),
          (error: { code?: number }) => {
            // 1: nothing found.
            if (error.code === 1) return ''
            throw error
          },
        )
        return { ...base, ok: true, matches: parseGrep(out, '').slice(0, CODE_FIND_MAX) }
      }
      case 'hashes': {
        const hashes: Record<string, string | null> = {}
        for (const path of request.paths ?? []) {
          const target = await resolve(path)
          if (!target) {
            hashes[path] = null
            continue
          }
          const { bytes } = await readStart(target, user).catch(() => ({ bytes: undefined }))
          hashes[path] =
            bytes && bytes.length <= FILE_VIEW_MAX && asText(bytes) !== undefined
              ? sha256(bytes)
              : null
        }
        return { ...base, ok: true, hashes }
      }
    }
  } catch (error) {
    return { ...base, ok: false, error: `Could not read the folder: ${String(error)}` }
  }
}
