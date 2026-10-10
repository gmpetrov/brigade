// Files a thread mentions, read for a person viewing them in the dashboard.
// Only inside a teammate's working folder for that thread or the library
// mirror, after resolving links; as the teammate's user on a cloud computer.
import { execFile } from 'node:child_process'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  FILE_VIEW_MAX,
  IMAGE_FILE,
  IMAGE_VIEW_MAX,
  type ApiToRunner,
  type RunnerToApi,
} from '@brigade/contracts'
import { CLOUD, paths } from './config.js'
import { LIBRARY_DIR } from './library.js'
import { teammateHome, teammateUser } from './teammates.js'

const run = promisify(execFile)
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

type Request = Extract<ApiToRunner, { type: 'thread.file.read' }>
type Result = Extract<RunnerToApi, { type: 'thread.file.result' }>

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The real path, or undefined when there is no such file (as `user` when given). */
async function real(path: string, user?: string) {
  if (!user) return realpath(path).catch(() => undefined)
  return run('sudo', ['-n', '-u', user, 'realpath', '-e', '--', path], { cwd: '/' }).then(
    ({ stdout }) => stdout.trim() || undefined,
    () => undefined,
  )
}

/** Size and the first `max` + 1 bytes. */
async function readStart(path: string, user?: string, max = FILE_VIEW_MAX) {
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
  if (request.image && !IMAGE_FILE.test(request.path))
    return { ...base, ok: false, error: 'Not an image' }
  for (const teammateId of request.teammateIds) {
    const user = CLOUD ? teammateUser(teammateId) : undefined
    const dir = user
      ? `${teammateHome(user)}/threads/${request.sessionId}`
      : paths.threadDir(teammateId, request.sessionId)
    const path = isAbsolute(request.path) ? request.path : join(dir, request.path)
    const target = await real(path, user)
    if (!target) continue
    const roots = (await Promise.all([real(dir, user), real(LIBRARY_DIR)])).filter(
      (r): r is string => Boolean(r),
    )
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
      return {
        ...base,
        ok: true,
        path: inside(dir, path) && !isAbsolute(request.path) ? request.path : target,
        teammateId,
        size,
        ...(text === undefined ? {} : { text }),
        truncated,
      }
    } catch (error) {
      return { ...base, ok: false, error: `Could not read it: ${String(error)}` }
    }
  }
  return { ...base, ok: false, error: 'not_found' }
}
