// Code from GitHub, through the API's git proxy (the GitHub credential stays in
// the API). Each teammate keeps a bare cache per repository; each thread gets
// its own checkout borrowing the cache's objects, on a brigade/ branch of its own.
// GitHub stays the source of truth: the computer's disk is a cache, swept of
// checkouts that hold nothing GitHub does not have.
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { GitAccess, ThreadSpec } from '@brigade/contracts'
import { CLOUD, HOME } from './config.js'
import { harnessEnv } from './harness/env.js'
import { teammateHome, teammateUser } from './teammates.js'

const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/
const GIT_TIMEOUT_MS = 15 * 60_000
/** A checkout untouched this long, with everything on GitHub, is removed. */
const STALE_CHECKOUT_DAYS = 14
/** A cache no checkout borrows from, not fetched this long, is removed. */
const STALE_CACHE_DAYS = 30
const STASH_MARK = 'Brigade: uncommitted work when the thread went quiet'

/**
 * Where a backup GitHub would not take is kept instead: the API's bucket. Keyed
 * by repository, thread, teammate and checkout folder.
 */
export type BundleStore = {
  put: (backup: BackupName, bundle: Buffer) => Promise<void>
  get: (backup: BackupName) => Promise<Buffer | null>
}
export type BackupName = {
  repository: string
  sessionId: string
  teammateId: string
  folder: string
}

/**
 * Git configuration for a teammate's processes, as environment so the token is
 * never written to disk: the proxy's token, and on a cloud computer github.com
 * URLs sent to the proxy and the teammate as commit author.
 */
export function gitEnv(git: GitAccess | undefined): Record<string, string> {
  if (!git) return {}
  const config: [string, string][] = [
    [`http.${git.url}.extraHeader`, `Authorization: Bearer ${git.token}`],
  ]
  // A member's own machine keeps the member's git setup; only Brigade's checkouts use the proxy.
  if (CLOUD)
    config.push(
      [`url.${git.url}.insteadOf`, 'https://github.com/'],
      [`url.${git.url}.insteadOf`, 'git@github.com:'],
      [`url.${git.url}.insteadOf`, 'ssh://git@github.com/'],
      ['user.name', git.author.name],
      ['user.email', git.author.email],
    )
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(config.length),
  }
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return env
}

type Run = {
  runAs?: string | undefined
  env?: Record<string, string>
  input?: Buffer
  timeout?: number
}

/**
 * Run a command as the teammate's user (sudo -E: the environment, and the token
 * in it, stay off the command line). Resolves to its stdout; rejects with its stderr.
 */
function run(file: string, args: string[], options: Run = {}): Promise<Buffer> {
  const { runAs } = options
  const env = harnessEnv({
    ...options.env,
    ...(runAs ? { HOME: teammateHome(runAs), USER: runAs, LOGNAME: runAs } : {}),
  })
  return new Promise((resolve, reject) => {
    const child = spawn(
      runAs ? 'sudo' : file,
      runAs ? ['-n', '-E', '-u', runAs, '--', file, ...args] : args,
      { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? GIT_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-20_000)))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(Buffer.concat(out))
      const message = (err.trim() || `${file} exited with ${code}`).replace(
        /bgit_[\w.-]+/g,
        '[token]',
      )
      reject(Object.assign(new Error(message), { code, stdout: Buffer.concat(out) }))
    })
    child.stdin.end(options.input)
  })
}

/** git as the teammate, with the proxy's token when given. */
const git = async (
  args: string[],
  access: GitAccess | undefined,
  runAs?: string,
  extra: Record<string, string> = {},
) => (await run('git', args, { runAs, env: { ...gitEnv(access), ...extra } })).toString().trim()

const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  )

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'teammate'

/** The teammate's branch in a thread: one per thread, the same in each repository. */
export const threadBranch = (spec: ThreadSpec) =>
  `brigade/${slug(spec.teammate.name)}-${spec.sessionId.slice(-8).toLowerCase()}`

/** A checkout folder as it appears in backup names. */
const backupFolder = (dir: string) =>
  basename(dir)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .toLowerCase()

/** Where a checkout's backup goes on GitHub. */
const wipBranch = (spec: ThreadSpec, folder: string) =>
  `brigade/wip/${spec.sessionId}/${slug(spec.teammate.name)}/${folder}`

const cacheRoot = (runAs?: string) =>
  runAs ? `${teammateHome(runAs)}/.repos` : join(HOME, 'repos')
const cachePath = (repository: string, runAs?: string) => `${cacheRoot(runAs)}/${repository}.git`

const caches = new Map<string, Promise<unknown>>()

/** The teammate's bare cache of a repository, created or brought up to date. One at a time per cache. */
function refreshCache(dir: string, remote: string, access: GitAccess, runAs?: string) {
  const previous = caches.get(dir) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (await succeeds(git(['-C', dir, 'rev-parse', '--git-dir'], access, runAs))) {
        // No --prune: checkouts may still borrow objects of branches deleted upstream.
        await git(['-C', dir, 'fetch', '--quiet', '--tags', 'origin'], access, runAs)
        return
      }
      await git(['clone', '--bare', '--quiet', remote, dir], access, runAs)
      for (const [key, value] of [
        ['remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
        // Never prune: checkouts borrow this cache's objects through alternates.
        ['gc.pruneExpire', 'never'],
      ] as const)
        await git(['-C', dir, 'config', key, value], access, runAs)
    })
  caches.set(dir, next)
  return next
}

export type CheckoutInput = { repository: string; base?: string; directory?: string }

/**
 * Check a repository out in the thread's working directory, on the teammate's
 * branch for the thread. An existing checkout is fetched, never reset. A new one
 * continues the thread's branch, or restores its backup. Setting it up is the
 * teammate's own work, from the repository's instructions.
 */
export async function checkout(input: {
  spec: ThreadSpec
  workDir: string
  runAs?: string
  request: CheckoutInput
  bundles: BundleStore
}) {
  const { spec, workDir, runAs, request } = input
  const access = spec.git
  if (!access) throw new Error('This teammate has no GitHub connection')
  const match = request.repository
    .trim()
    .replace(/\.git$/, '')
    .match(REPO)
  if (!match) throw new Error('Give the repository as owner/name, e.g. acme/web')
  const [, owner, name] = match as unknown as [string, string, string]
  const repository = `${owner}/${name}`.toLowerCase()
  if (request.base !== undefined && !BRANCH.test(request.base))
    throw new Error('Invalid base branch')
  const folder = request.directory ?? name
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(folder) || folder.startsWith('.'))
    throw new Error('directory is a folder name inside your working directory, e.g. "web"')

  const remote = `${access.url}${owner}/${name}.git`
  const dir = `${workDir}/${folder}`
  const branch = threadBranch(spec)

  await refreshCache(cachePath(repository, runAs), remote, access, runAs)
  if (await succeeds(git(['-C', dir, 'rev-parse', '--git-dir'], access, runAs))) {
    await git(['-C', dir, 'fetch', '--quiet', 'origin'], access, runAs)
    return {
      directory: dir,
      branch: await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], access, runAs),
      status: await git(['-C', dir, 'status', '--short', '--branch'], access, runAs),
      note: 'Already checked out: fetched from GitHub, your files are untouched.',
    }
  }
  await git(
    [
      'clone',
      '--quiet',
      '--reference',
      cachePath(repository, runAs),
      ...(request.base ? ['--branch', request.base] : []),
      remote,
      dir,
    ],
    access,
    runAs,
  )
  const base = await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], access, runAs)
  const at = (ref: string) =>
    git(['-C', dir, 'rev-parse', '--verify', '--quiet', ref], access, runAs).catch(() => '')
  // Back in a thread (e.g. after its checkout was swept): continue its branch on GitHub,
  // or the backup made when it went quiet if that holds more.
  const pushed = Boolean(await at(`refs/remotes/origin/${branch}`))
  const restored = await restore({
    spec,
    dir,
    runAs,
    access,
    repository,
    branch,
    pushed,
    bundles: input.bundles,
  })
  if (!restored)
    await git(
      [
        '-C',
        dir,
        'checkout',
        '--quiet',
        '-b',
        branch,
        ...(pushed ? ['--track', `origin/${branch}`] : []),
      ],
      access,
      runAs,
    )
  return {
    directory: dir,
    branch,
    base,
    continued: pushed,
    ...(restored ? { restored } : {}),
    note:
      `Work on ${branch} (from ${base}). Before changing anything, read the repository's AGENTS.md, ` +
      'CLAUDE.md or README and set it up as they say (install dependencies, copy example config). ' +
      `Commit as you go and push with \`git push -u origin HEAD\`; ` +
      'only branches under brigade/ can be pushed. Open a pull request with the GitHub tool when it is ready.',
  }
}

/**
 * A new checkout of a thread: start from the backup Brigade made when the
 * thread went quiet (on GitHub, or in the bucket when the branch never reached
 * GitHub), unless the branch on GitHub moved past it. Returns where it came
 * from, or undefined when there is nothing newer than the branch.
 */
async function restore(input: {
  spec: ThreadSpec
  dir: string
  runAs: string | undefined
  access: GitAccess
  repository: string
  branch: string
  /** The thread's branch is on GitHub. */
  pushed: boolean
  bundles: BundleStore
}) {
  const { spec, dir, runAs, access, branch, pushed } = input
  const folder = backupFolder(dir)
  const wip = wipBranch(spec, folder)
  const g = (args: string[], extra?: Record<string, string>) =>
    git(['-C', dir, ...args], access, runAs, extra)
  let commit = await g(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${wip}`]).catch(
    () => '',
  )
  let from = `GitHub (${wip})`
  if (!commit) {
    if (pushed) return undefined
    const bundle = await input.bundles
      .get({
        repository: input.repository,
        sessionId: spec.sessionId,
        teammateId: spec.teammate.id,
        folder,
      })
      .catch(() => null)
    if (!bundle) return undefined
    const file = `${dir}/.git/brigade-restore.bundle`
    await run('sh', ['-c', 'cat >"$1"', 'write', file], { runAs, input: bundle })
    try {
      await g(['fetch', '--quiet', file, '+refs/brigade/backup:refs/brigade/restored'])
      commit = await g(['rev-parse', 'refs/brigade/restored'])
    } finally {
      await run('rm', ['-f', file], { runAs }).catch(() => undefined)
    }
    from = "Brigade's backup storage"
  }
  // A snapshot of uncommitted changes sits on the commit it was made from: check that out, apply it.
  const parents = (await g(['rev-list', '--parents', '-n', '1', commit])).split(' ').length - 1
  const subject = await g(['log', '-1', '--format=%s', commit])
  const snapshot = parents === 2 && subject.includes(STASH_MARK)
  const base = snapshot ? `${commit}^1` : commit
  // A backup older than what was pushed since: the branch on GitHub wins.
  if (
    pushed &&
    !(await succeeds(g(['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, base])))
  )
    return undefined
  await g(['checkout', '--quiet', '-b', branch, base])
  if (snapshot) await g(['stash', 'apply', '--quiet', commit])
  if (pushed) await g(['branch', '--quiet', `--set-upstream-to=origin/${branch}`])
  await g(['update-ref', '-d', 'refs/brigade/restored']).catch(() => undefined)
  return `Your unpushed work in this thread was restored from ${from}. Check it with git status and git log.`
}

/**
 * Back up what a teammate has not pushed in each of its checkouts of a thread:
 * commits, and changes to tracked files as one more commit, to
 * brigade/wip/<thread>/<teammate>/<folder> on GitHub, or to the bucket when
 * GitHub will not take it (a read-only grant, say). Its own branch and files
 * are left alone. New untracked files are not backed up: they may hold secrets.
 */
export async function backup(input: {
  spec: ThreadSpec
  workDir: string
  runAs?: string
  bundles: BundleStore
}) {
  const { spec, workDir, runAs } = input
  const access = spec.git
  if (!access) return
  const found = await run('find', [workDir, '-mindepth', '2', '-maxdepth', '2', '-name', '.git'], {
    runAs,
  }).catch(() => Buffer.alloc(0))
  const author = {
    GIT_AUTHOR_NAME: access.author.name,
    GIT_AUTHOR_EMAIL: access.author.email,
    GIT_COMMITTER_NAME: access.author.name,
    GIT_COMMITTER_EMAIL: access.author.email,
  }
  for (const marker of found.toString().split('\n').filter(Boolean)) {
    const dir = marker.replace(/\/\.git$/, '')
    const folder = backupFolder(dir)
    const ref = `refs/heads/${wipBranch(spec, folder)}`
    const g = (args: string[], extra?: Record<string, string>) =>
      git(['-C', dir, ...args], access, runAs, extra)
    try {
      // Only checkouts that push through Brigade.
      const url = await g(['ls-remote', '--get-url', 'origin'])
      if (!url.startsWith(access.url)) continue
      const repository = url
        .slice(access.url.length)
        .replace(/\.git$/, '')
        .toLowerCase()
      const snapshot = await g(['stash', 'create', STASH_MARK], author)
      const commit = snapshot || (await g(['rev-parse', '--verify', '--quiet', 'HEAD']))
      // Already on GitHub (pushed, or nothing done): nothing to keep.
      if (await g(['branch', '--remotes', '--contains', commit])) continue
      try {
        await g(['push', '--quiet', '--force', 'origin', `${commit}:${ref}`])
        console.log(`backed up ${dir} to ${ref.replace(/^refs\/heads\//, '')}`)
      } catch (error) {
        // GitHub would not take it: a bundle of what it lacks, in Brigade's own storage.
        await g(['update-ref', 'refs/brigade/backup', commit])
        try {
          const bundle = await run(
            'git',
            [
              '-C',
              dir,
              'bundle',
              'create',
              '--quiet',
              '-',
              'refs/brigade/backup',
              '--not',
              '--remotes',
            ],
            { runAs },
          )
          await input.bundles.put(
            { repository, sessionId: spec.sessionId, teammateId: spec.teammate.id, folder },
            bundle,
          )
          console.log(`backed up ${dir} to Brigade's storage (GitHub refused: ${message(error)})`)
        } finally {
          await g(['update-ref', '-d', 'refs/brigade/backup']).catch(() => undefined)
        }
      }
    } catch (error) {
      console.warn(`could not back up ${dir}: ${message(error)}`)
    }
  }
}

/**
 * A repository got a push on GitHub: fetch it into the caches this computer
 * already has, with the fetch-only tokens the API sent. Creates none.
 */
export async function prefetch(
  repository: string,
  teammates: { teammateId: string; url: string; token: string }[],
) {
  if (!REPO.test(repository)) return
  const access = (t: (typeof teammates)[number]): GitAccess => ({
    url: t.url,
    token: t.token,
    author: { name: 'Brigade', email: 'brigade@brigade.invalid' },
  })
  // On a member's machine all teammates share one cache.
  const targets = CLOUD
    ? teammates.map((t) => ({ t, runAs: teammateUser(t.teammateId) }))
    : teammates.slice(0, 1).map((t) => ({ t, runAs: undefined }))
  for (const { t, runAs } of targets) {
    const dir = cachePath(repository.toLowerCase(), runAs)
    if (!(await succeeds(run('test', ['-d', dir], { runAs })))) continue
    await refreshCache(dir, `${t.url}${repository}.git`, access(t), runAs).catch((error) =>
      console.warn(
        `could not fetch ${repository} for ${runAs ?? 'this machine'}: ${message(error)}`,
      ),
    )
  }
}

/** The teammate users on this cloud computer, or one entry for this machine's own user. */
async function owners(): Promise<(string | undefined)[]> {
  if (!CLOUD) return [undefined]
  const names = await readdir('/home').catch(() => [] as string[])
  return names.filter((n) => /^bt-[a-z0-9]{1,28}$/.test(n))
}

const findAs = async (runAs: string | undefined, args: string[]) =>
  (await run('find', args, { runAs }).catch(() => Buffer.alloc(0)))
    .toString()
    .split('\n')
    .filter(Boolean)

/**
 * Free disk: remove checkouts untouched for STALE_CHECKOUT_DAYS that hold
 * nothing GitHub lacks (no changes, untracked files, stashes or unpushed
 * commits), then caches no checkout borrows from. A thread that comes back
 * checks its repository out again and continues its branch.
 */
export async function sweep(inUse: (sessionId: string) => boolean) {
  const removed: string[] = []
  for (const runAs of await owners()) {
    const threadsRoot = runAs ? `${teammateHome(runAs)}/threads` : join(HOME, 'teammates')
    const depth = runAs ? '3' : '5' // threads/<thread>/<folder>/.git, or teammates/<id>/threads/<thread>/<folder>/.git
    const markers = await findAs(runAs, [
      threadsRoot,
      '-mindepth',
      depth,
      '-maxdepth',
      depth,
      '-name',
      '.git',
      '-type',
      'd',
    ])
    const kept: string[] = []
    for (const marker of markers) {
      const dir = marker.replace(/\/\.git$/, '')
      const sessionId = dir.split('/').at(-2) ?? ''
      const g = (args: string[]) => git(['-C', dir, ...args], undefined, runAs)
      try {
        if (inUse(sessionId)) throw new Error('in use')
        const recent = await findAs(runAs, [
          marker,
          '-maxdepth',
          '1',
          '(',
          '-name',
          'index',
          '-o',
          '-name',
          'HEAD',
          '-o',
          '-name',
          'FETCH_HEAD',
          ')',
          '-mtime',
          `-${STALE_CHECKOUT_DAYS}`,
        ])
        if (recent.length > 0) throw new Error('recent')
        // --no-optional-locks: looking must not refresh the index, which would make it look recent.
        if (await g(['--no-optional-locks', 'status', '--porcelain'])) throw new Error('changes')
        if (await g(['stash', 'list'])) throw new Error('stashes')
        if (await g(['rev-list', '-n', '1', '--branches', 'HEAD', '--not', '--remotes']))
          throw new Error('unpushed commits')
        await run('rm', ['-rf', '--', dir], { runAs })
        removed.push(dir)
      } catch {
        kept.push(dir)
      }
    }
    // Caches that no remaining checkout borrows from.
    const borrowed = new Set<string>()
    for (const dir of kept) {
      const alternates = await run('cat', [`${dir}/.git/objects/info/alternates`], { runAs }).catch(
        () => Buffer.alloc(0),
      )
      for (const line of alternates.toString().split('\n'))
        if (line.trim()) borrowed.add(line.trim().replace(/\/objects\/?$/, ''))
    }
    const root = cacheRoot(runAs)
    for (const cache of await findAs(runAs, [
      root,
      '-mindepth',
      '2',
      '-maxdepth',
      '2',
      '-name',
      '*.git',
      '-type',
      'd',
    ])) {
      if (borrowed.has(cache)) continue
      const recent = await findAs(runAs, [
        cache,
        '-maxdepth',
        '1',
        '(',
        '-name',
        'FETCH_HEAD',
        '-o',
        '-name',
        'packed-refs',
        '-o',
        '-name',
        'HEAD',
        ')',
        '-mtime',
        `-${STALE_CACHE_DAYS}`,
      ])
      if (recent.length > 0) continue
      await run('rm', ['-rf', '--', cache], { runAs }).catch(() => undefined)
      removed.push(cache)
    }
  }
  for (const dir of removed) console.log(`removed ${dir}: nothing in it that GitHub lacks`)
  return removed
}
