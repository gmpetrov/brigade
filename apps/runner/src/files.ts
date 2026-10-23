// Files a thread mentions, read for a person viewing them in the dashboard.
// Only inside a teammate's working folder for that thread or the library
// mirror, after resolving links; as the teammate's user on a cloud computer.
// A person may also save a text file of the working folder (never the library
// mirror), and find where an element of the thread's preview is written.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, realpath, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  FILE_VIEW_MAX,
  IMAGE_VIEW_MAX,
  VIEWABLE_FILE,
  type ApiToRunner,
  type RunnerToApi,
  type SourceMatch,
} from '@brigade/contracts'
import { CLOUD, paths } from './config.js'
import { libraryDirFor } from './library.js'
import { run as runAs } from './repos.js'
import { teammateHome, teammateUser } from './teammates.js'

const run = promisify(execFile)
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

type Request = Extract<ApiToRunner, { type: 'thread.file.read' }>
type Result = Extract<RunnerToApi, { type: 'thread.file.result' }>
type WriteRequest = Extract<ApiToRunner, { type: 'thread.file.write' }>
type WriteResult = Extract<RunnerToApi, { type: 'thread.file.written' }>
type FindRequest = Extract<ApiToRunner, { type: 'thread.source.find' }>
type FindResult = Extract<RunnerToApi, { type: 'thread.source.result' }>

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** The teammate's working folder for the thread, and the user to act as on a cloud computer. */
function workDir(teammateId: string, sessionId: string) {
  const user = CLOUD ? teammateUser(teammateId) : undefined
  const dir = user
    ? `${teammateHome(user)}/threads/${sessionId}`
    : paths.threadDir(teammateId, sessionId)
  return { user, dir }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The real path, or undefined when there is no such file (as `user` when given). */
export async function real(path: string, user?: string) {
  if (!user) return realpath(path).catch(() => undefined)
  return run('sudo', ['-n', '-u', user, 'realpath', '-e', '--', path], { cwd: '/' }).then(
    ({ stdout }) => stdout.trim() || undefined,
    () => undefined,
  )
}

/** Size and the first `max` + 1 bytes. */
export async function readStart(path: string, user?: string, max = FILE_VIEW_MAX) {
  if (!user) {
    const size = (await stat(path)).size
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(size, max + 1))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return { size, bytes: buffer.subarray(0, bytesRead) }
    } finally {
      await file.close()
    }
  }
  const sudo = ['-n', '-u', user]
  const { stdout: sizeText } = await run('sudo', [...sudo, 'stat', '-c', '%s', '--', path], {
    cwd: '/',
  })
  const { stdout } = await run('sudo', [...sudo, 'head', '-c', String(max + 1), '--', path], {
    cwd: '/',
    encoding: 'buffer',
    maxBuffer: max + 1024,
  })
  return { size: Number(sizeText.trim()), bytes: stdout }
}

function asText(bytes: Buffer) {
  if (bytes.subarray(0, 8000).includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Cut mid-character at the limit: drop the partial one.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - 3))
    } catch {
      return undefined
    }
  }
}

export async function readThreadFile(request: Request): Promise<Result> {
  const base = { type: 'thread.file.result' as const, requestId: request.requestId }
  if (!SAFE_ID.test(request.sessionId) || !request.teammateIds.every((id) => SAFE_ID.test(id)))
    return { ...base, ok: false, error: 'Invalid thread' }
  if (request.image && !VIEWABLE_FILE.test(request.path))
    return { ...base, ok: false, error: 'Not an image or PDF' }
  for (const teammateId of request.teammateIds) {
    const { user, dir } = workDir(teammateId, request.sessionId)
    const path = isAbsolute(request.path) ? request.path : join(dir, request.path)
    const target = await real(path, user)
    if (!target) continue
    const [own, library] = await Promise.all([real(dir, user), real(libraryDirFor(teammateId))])
    const roots = [own, library].filter((r): r is string => Boolean(r))
    if (!roots.some((root) => inside(root, target))) continue
    try {
      if (request.image) {
        const { size, bytes } = await readStart(target, user, IMAGE_VIEW_MAX)
        if (bytes.length > IMAGE_VIEW_MAX)
          return { ...base, ok: false, error: 'The image is too large to show' }
        return { ...base, ok: true, path: target, teammateId, size, data: bytes.toString('base64') }
      }
      const { size, bytes } = await readStart(target, user)
      const truncated = bytes.length > FILE_VIEW_MAX
      const text = asText(truncated ? bytes.subarray(0, FILE_VIEW_MAX) : bytes)
      // Only a whole text file of the working folder can be saved again.
      const editable = text !== undefined && !truncated && !!own && inside(own, target)
      return {
        ...base,
        ok: true,
        path: inside(dir, path) && !isAbsolute(request.path) ? request.path : target,
        teammateId,
        size,
        ...(text === undefined ? {} : { text }),
        truncated,
        ...(editable ? { hash: sha256(bytes) } : {}),
      }
    } catch (error) {
      return { ...base, ok: false, error: `Could not read it: ${String(error)}` }
    }
  }
  return { ...base, ok: false, error: 'not_found' }
}

/**
 * Save a text file of a teammate's working folder for the thread, as a person edited
 * it. Only a file that is there already, and with `base`, only while it is as it was
 * read: otherwise `conflict`, and nothing is written.
 */
export async function writeThreadFile(request: WriteRequest): Promise<WriteResult> {
  const base = { type: 'thread.file.written' as const, requestId: request.requestId }
  if (!SAFE_ID.test(request.sessionId) || !SAFE_ID.test(request.teammateId))
    return { ...base, ok: false, error: 'Invalid thread' }
  const { user, dir } = workDir(request.teammateId, request.sessionId)
  const own = await real(dir, user)
  const target = await real(isAbsolute(request.path) ? request.path : join(dir, request.path), user)
  if (!own || !target) return { ...base, ok: false, error: 'not_found' }
  if (!inside(own, target) || target === own)
    return { ...base, ok: false, error: "Only files in the teammate's folder can be saved" }
  try {
    const { bytes } = await readStart(target, user)
    if (bytes.length > FILE_VIEW_MAX) return { ...base, ok: false, error: 'The file is too large' }
    if (asText(bytes) === undefined) return { ...base, ok: false, error: 'Not a text file' }
    if (request.base !== undefined && sha256(bytes) !== request.base)
      return { ...base, ok: false, conflict: true, error: 'The file changed since it was opened' }
    const data = Buffer.from(request.text, 'utf8')
    // In place: the file keeps its owner and mode, and the dev server sees one change.
    if (user) await runAs('sh', ['-c', 'cat > "$1"', 'sh', target], { runAs: user, input: data })
    else await writeFile(target, data)
    return { ...base, ok: true, hash: sha256(data) }
  } catch (error) {
    return { ...base, ok: false, error: `Could not save it: ${String(error)}` }
  }
}

/** Source files first: what a person means by "the code" of what they see. */
const SOURCE = /^\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|html?|mdx|erb|hbs|liquid|php|py|rb)$/
const NOT_SOURCE =
  /(^|\/)(test|tests|__tests__|e2e|fixtures|dist|build|\.next)\/|\.(test|spec)\.|\.lock$|lock\.json$/

/**
 * Pieces of an element's text to look for, longest first: its text as a whole and
 * its sentences and clauses, since the source may break it with markup or lines.
 */
export function fragments(text: string) {
  const whole = text.replace(/\s+/g, ' ').replace(/…$/, '').trim()
  const pieces = whole
    .split(/[.!?;:,()"“”«»‘’'`]|\s[-–—·|/]\s/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 6 && /\p{L}/u.test(p))
  return [
    ...new Set([whole.length <= 200 ? whole : '', ...pieces.sort((a, b) => b.length - a.length)]),
  ]
    .filter((p) => p.length >= 3)
    .slice(0, 6)
}

/** Best first: source files outside tests, then those named after one of its components. */
export function rank(matches: SourceMatch[], components: string[] = []) {
  const names = components.map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
  const score = (m: SourceMatch) => {
    const file = m.path.split('/').pop()!.toLowerCase()
    const bare = file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '')
    return (
      (SOURCE.test(extname(file)) ? 4 : 0) +
      (NOT_SOURCE.test(m.path) ? -4 : 0) +
      (names.some((n) => n === bare || n.includes(bare) || bare.includes(n)) ? 2 : 0)
    )
  }
  return matches
    .map((m, i) => ({ m, s: score(m), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ m }) => m)
}

/** `git grep -z -n` lines: path, line and text, each ended by NUL but the text. */
export function parseGrep(output: string, prefix: string): SourceMatch[] {
  return output
    .split('\n')
    .map((line) => line.split('\0'))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[1]!))
    .map(([path, line, ...rest]) => ({
      path: normalize(join(prefix, path!)),
      line: Number(line),
      preview: rest.join(' ').trim().slice(0, 200),
    }))
}

/**
 * Where an element of the thread's preview is written: its text, ignoring case (CSS
 * may change it), in the preview's folder, leaving out what git ignores (node_modules, builds).
 */
export async function findSource(request: FindRequest): Promise<FindResult> {
  const base = { type: 'thread.source.result' as const, requestId: request.requestId }
  if (!SAFE_ID.test(request.sessionId) || !SAFE_ID.test(request.teammateId))
    return { ...base, ok: false, error: 'Invalid thread' }
  const { user, dir } = workDir(request.teammateId, request.sessionId)
  const own = await real(dir, user)
  const root = await real(resolve(dir, request.cwd || '.'), user)
  if (!own || !root || !inside(own, root))
    return { ...base, ok: false, error: "The preview's folder is not in the teammate's folder" }
  const prefix = relative(own, root)
  try {
    for (const fragment of fragments(request.text)) {
      const output = await runAs(
        'git',
        // --no-index: a folder that is no repository too; --exclude-standard: not what git ignores.
        [
          '-C',
          root,
          'grep',
          '--no-index',
          '--exclude-standard',
          '-z',
          '-n',
          '-I',
          '-i',
          '-F',
        ].concat(['--max-count=5', '-e', fragment]),
        { runAs: user, timeout: 15_000 },
      ).then(
        (out) => out.toString('utf8'),
        (error: { code?: number }) => {
          // 1: nothing found.
          if (error.code === 1) return ''
          throw error
        },
      )
      const matches = parseGrep(output, prefix)
      if (matches.length)
        return { ...base, ok: true, matches: rank(matches, request.components).slice(0, 20) }
    }
    return { ...base, ok: true, matches: [] }
  } catch (error) {
    return { ...base, ok: false, error: `Could not search the code: ${String(error)}` }
  }
}
