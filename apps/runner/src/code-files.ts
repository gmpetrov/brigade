// The code panel's view of a teammate's working folder for a thread (thread.code):
// a folder's entries for its tree, files by name and lines by text for its filter,
// and open files' hashes, so the panel sees when the teammate changed one. Never
// outside the working folder, after resolving links; as the teammate's user on a
// cloud computer. `find`'s and `git grep`'s plain options only: Macs run it too.
// And what changed on the branch of each of the folder's repositories, since it
// left its default branch (committed or not): the files, a file as it was there,
// and files put back as they were. A repository with no default branch to compare
// to (no remote, or on it with nothing to push) compares to its last commit.
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path'
import {
  CODE_CHANGES_MAX,
  CODE_FIND_MAX,
  CODE_LIST_MAX,
  FILE_VIEW_MAX,
  type ApiToRunner,
  type CodeChange,
  type CodeEntry,
  type RunnerToApi,
} from '@brigade/contracts'
import { asText, inside, parseGrep, readStart, real, SAFE_ID, sha256, workDir } from './files.js'
import { run } from './repos.js'
import { teammateHome } from './teammates.js'
import { asTeammate, threadNet } from './thread-net.js'

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

/** How deep in the working folder repositories are looked for: `<repo>/`, `<a>/<repo>/`… */
const REPO_DEPTH = 4

/** The status of a file against the last commit, from `git status --porcelain`'s XY; undefined: none. */
export function changeStatus(xy: string): CodeChange['status'] | undefined {
  const [x, y] = [xy[0], xy[1]]
  if (xy === '??') return 'A'
  // Added, even when then deleted from the folder only: what is staged would be committed.
  if (x === 'A') return 'A'
  if (x === 'D' || y === 'D') return 'D'
  return 'M'
}

/** `git status --porcelain -z --no-renames`: files and their status, `prefix` before each path. */
export function parseStatus(output: string, prefix: string): CodeChange[] {
  const changes: CodeChange[] = []
  for (const entry of output.split('\0')) {
    if (entry.length < 4) continue
    const path = entry.slice(3)
    // A repository inside this one, not tracked: its own files show on their own.
    if (path.endsWith('/')) continue
    const status = changeStatus(entry.slice(0, 2))
    if (status) changes.push({ path: normalize(join(prefix, path)), status })
  }
  return changes
}

/** The repositories of the working folder: the folders holding a `.git`, relative to it. */
async function repositories(own: string, user: string | undefined) {
  const prune = SKIPPED.filter((n) => n !== '.git')
    .map((n) => `-name '${n}'`)
    .join(' -o ')
  const out = await sh(
    `find "$1" -maxdepth ${REPO_DEPTH} \\( ${prune} \\) -prune -o -name .git -print -prune 2>/dev/null; true`,
    [own],
    user,
  )
  return out
    .split('\n')
    .filter(Boolean)
    .map((p) => dirname(p))
    .filter((p) => inside(own, p))
    .sort()
}

/** Git, reading, as the teammate; `--no-optional-locks`: never in the way of the teammate's own git. */
const git = (args: string[], user: string | undefined) =>
  run('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
    runAs: user,
    timeout: 15_000,
  })

/**
 * Where a path of the working folder is in its repository, whether or not it is
 * there now (a deleted file): the repository's top and the path in it, the file's
 * absolute path. Undefined outside the working folder or any repository of it.
 */
async function inRepository(own: string, path: string, user: string | undefined) {
  const asked = normalize(isAbsolute(path) ? path : join(own, path))
  if (!inside(own, asked) || asked === own) return undefined
  // The nearest folder of it that is there, links resolved.
  let folder = dirname(asked)
  let found = await real(folder, user)
  while (!found && inside(own, folder) && folder !== own) {
    folder = dirname(folder)
    found = await real(folder, user)
  }
  if (!found || !inside(own, found)) return undefined
  const file = join(found, relative(folder, asked))
  const top = await git(['-C', found, 'rev-parse', '--show-toplevel'], user).then(
    (out) => out.toString('utf8').trim(),
    () => undefined,
  )
  const realTop = top && (await real(top, user))
  if (!realTop || !inside(own, realTop)) return undefined
  return { top: realTop, rel: relative(realTop, file), file }
}

/** `git diff --name-status -z --no-renames`: files and their status, `prefix` before each path. */
export function parseNameStatus(output: string, prefix: string): CodeChange[] {
  const changes: CodeChange[] = []
  const fields = output.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [letter, path] = [fields[i]![0], fields[i + 1]!]
    if (!letter || !path) continue
    // T (a file turned link, or back) and U (unmerged): changed.
    const status = letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M'
    changes.push({ path: normalize(join(prefix, path)), status })
  }
  return changes
}

/**
 * Where the repository's branch left its default branch: the commit and the branch's
 * name ("main"), from the remote's default (origin/HEAD), else origin/main or origin/master,
 * as last fetched (never fetched here). Undefined with none to compare to.
 */
export async function branchBase(top: string, user: string | undefined) {
  const verify = (ref: string) =>
    git(['-C', top, 'rev-parse', '-q', '--verify', `${ref}^{commit}`], user).then(
      () => ref,
      () => undefined,
    )
  const remoteHead = await git(
    ['-C', top, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'],
    user,
  ).then(
    (out) => out.toString('utf8').trim() || undefined,
    () => undefined,
  )
  const ref =
    (remoteHead && (await verify(remoteHead))) ??
    (await verify('origin/main')) ??
    (await verify('origin/master'))
  if (!ref) return undefined
  const commit = await git(['-C', top, 'merge-base', 'HEAD', ref], user).then(
    (out) => out.toString('utf8').trim(),
    () => undefined,
  )
  return commit ? { commit, name: ref.replace(/^origin\//, '') } : undefined
}

/** The file as in a commit of its repository (the last one by default); null when it is in none. */
async function committed(top: string, rel: string, user: string | undefined, rev = 'HEAD') {
  const size = await git(['-C', top, 'cat-file', '-s', `${rev}:${rel}`], user).then(
    (out) => Number(out.toString('utf8').trim()),
    () => undefined,
  )
  if (size === undefined) return null
  if (size > FILE_VIEW_MAX) throw new Error('The file is too large')
  const text = asText(await git(['-C', top, 'show', `${rev}:${rel}`], user))
  if (text === undefined) throw new Error('Not a text file')
  return text
}

/**
 * Git as the teammate in its thread's namespaces, where its preview's dev server
 * runs: a file it writes is seen there as the teammate's own edits are (files.ts's
 * writeInThread says why).
 */
async function inThread(sessionId: string, user: string | undefined, command: string[]) {
  if (!user) return run(command[0]!, command.slice(1), { timeout: 30_000 })
  const as = asTeammate(user, await threadNet(sessionId))
  return run(as.file, [...as.args, ...command], {
    env: { HOME: teammateHome(user), USER: user, LOGNAME: user },
    timeout: 30_000,
  })
}

export async function codeFiles(request: Request): Promise<Result> {
  const base = { type: 'thread.code.result' as const, requestId: request.requestId }
  if (!SAFE_ID.test(request.sessionId) || !SAFE_ID.test(request.teammateId))
    return { ...base, ok: false, error: 'Invalid thread' }
  const { user, dir } = workDir(request.teammateId, request.sessionId)
  const own = await real(dir, user)
  if (!own) return { ...base, ok: false, error: 'not_found' }
  /** A path of the working folder (relative to it, or absolute), resolved; undefined when it is not one. */
  const resolve = async (path: string) => {
    const target = await real(isAbsolute(path) ? path : join(own, path), user)
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
      case 'changes': {
        const changes: CodeChange[] = []
        const heads: string[] = []
        /** What each repository compares to: its default branch's name, or '' for its last commit. */
        const bases = new Set<string>()
        for (const top of await repositories(own, user)) {
          const [status, head, from] = await Promise.all([
            git(
              [
                '-C',
                top,
                'status',
                '--porcelain=v1',
                '-z',
                '--no-renames',
                '--untracked-files=all',
              ],
              user,
            ),
            git(['-C', top, 'rev-parse', '-q', '--verify', 'HEAD'], user).catch(() => undefined),
            branchBase(top, user),
          ]).catch(() => [undefined, undefined, undefined] as const)
          // Not a repository after all (a stray .git), or a broken one: none of its files.
          if (!status) continue
          const prefix = relative(own, top)
          const uncommitted = parseStatus(status.toString('utf8'), prefix)
          const sinceBase =
            from &&
            (await git(
              ['-C', top, 'diff', '--name-status', '-z', '--no-renames', from.commit, '--'],
              user,
            ).then(
              (out) => parseNameStatus(out.toString('utf8'), prefix),
              () => undefined,
            ))
          if (sinceBase) {
            // The folder against the base; with the new files that misses (not yet tracked,
            // or staged then deleted from the folder), as git status has them. Not its other
            // files: changed since the last commit, a file put back as on the base is not.
            const seen = new Set(sinceBase.map((c) => c.path))
            changes.push(
              ...[
                ...sinceBase,
                ...uncommitted.filter((c) => c.status === 'A' && !seen.has(c.path)),
              ].map((c) => ({ ...c, base: from.name })),
            )
            bases.add(from.name)
          } else {
            changes.push(...uncommitted)
            bases.add('')
          }
          heads.push(
            `${prefix}:${head?.toString('utf8').trim() ?? ''}${sinceBase ? `:${from.commit}` : ''}`,
          )
        }
        changes.sort((a, b) => a.path.localeCompare(b.path))
        return {
          ...base,
          ok: true,
          changes: changes.slice(0, CODE_CHANGES_MAX),
          ...(changes.length > CODE_CHANGES_MAX ? { more: true } : {}),
          head: heads.join(' '),
          // What they compare to, when each repository compares to its default branch.
          ...(bases.size && !bases.has('')
            ? { base: bases.size === 1 ? [...bases][0]! : 'the default branch' }
            : {}),
        }
      }
      case 'original': {
        const where = await inRepository(own, request.path ?? '', user)
        if (!where) return { ...base, ok: true, original: null }
        const from = await branchBase(where.top, user)
        return {
          ...base,
          ok: true,
          original: await committed(where.top, where.rel, user, from?.commit),
        }
      }
      case 'revert': {
        /** What they were put back as: a default branch's name, or '' for a last commit. */
        const bases = new Set<string>()
        for (const path of request.paths ?? []) {
          const where = await inRepository(own, path, user)
          if (!where) return { ...base, ok: false, error: `${path} is in no repository` }
          // As where the branch left its default branch, as Changes compares to.
          const from = await branchBase(where.top, user)
          bases.add(from?.name ?? '')
          const rev = from?.commit ?? 'HEAD'
          const known = await git(['-C', where.top, 'cat-file', '-e', `${rev}:${where.rel}`], user)
            .then(() => true)
            .catch(() => false)
          if (known) {
            // As in that commit, in the index too: staged, to commit when it is not the last.
            await inThread(request.sessionId, user, [
              'git',
              '--literal-pathspecs',
              '-C',
              where.top,
              'checkout',
              rev,
              '--',
              where.rel,
            ])
            continue
          }
          // New since: out of the index, and gone.
          await inThread(request.sessionId, user, [
            'git',
            '--literal-pathspecs',
            '-C',
            where.top,
            'rm',
            '-q',
            '-f',
            '--cached',
            '--ignore-unmatch',
            '--',
            where.rel,
          ])
          // Whatever is there, a link leading nowhere too (-f: or nothing).
          await inThread(request.sessionId, user, ['rm', '-f', '--', where.file])
        }
        return {
          ...base,
          ok: true,
          // As on a default branch, when all were: the thread is told so.
          ...(bases.size && !bases.has('')
            ? { base: bases.size === 1 ? [...bases][0]! : 'their default branch' }
            : {}),
        }
      }
    }
  } catch (error) {
    return { ...base, ok: false, error: `Could not read the folder: ${String(error)}` }
  }
}
