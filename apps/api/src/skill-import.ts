// Importing skills made elsewhere (Claude, Codex, Grok, a repository): a
// SKILL.md, a zip of one skill's folder or of many (a pack), or a GitHub
// repository or a folder of one. Read for a person to review; never saved here.
import {
  SKILL_ENTRY,
  SKILL_FILE_MAX,
  SKILL_FILES_MAX,
  SKILL_PACK_MAX,
  parseSkillMarkdown,
  skillSlug,
} from '@brigade/contracts'
import { Unzip, UnzipInflate, unzipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'

/** One skill an upload holds: its SKILL.md read, the files beside it as bytes. */
export type FoundSkill = {
  /** Its folder in the upload, e.g. `skills/pdf`; empty for a lone SKILL.md. */
  folder: string
  name: string
  description: string
  instructions: string
  files: { path: string; bytes: Uint8Array }[]
  /** Files left out: too large, or past the limit. */
  skipped: string[]
}

const text = new TextDecoder('utf-8', { fatal: true })

function decode(bytes: Uint8Array) {
  if (bytes.includes(0)) return null
  try {
    return text.decode(bytes)
  } catch {
    return null
  }
}

/** Files that are no one's content: a Mac's or an editor's. */
const ignored = (path: string) =>
  path.endsWith('/') ||
  path.startsWith('__MACOSX/') ||
  path.split('/').some((part) => part.startsWith('.') || part === 'node_modules')

const UNREADABLE = 'Upload a SKILL.md, or a .zip or .skill of a skill folder or of many'
const isZip = (head: Uint8Array) => head[0] === 0x50 && head[1] === 0x4b
const baseName = (fileName: string) =>
  fileName.replace(/^.*[\\/]/, '').replace(/\.(md|zip|skill)$/i, '')

/** A lone SKILL.md's skill. */
function loneSkill(bytes: Uint8Array, base: string) {
  const markdown = decode(bytes)
  if (markdown === null) throw new HTTPException(400, { message: UNREADABLE })
  return fromMarkdown(markdown, '', base === 'SKILL' ? '' : base, [], [])
}

/**
 * Every skill in a SKILL.md or a zip (Claude's `.skill` files are zips), its
 * files those under its folder that no deeper skill holds. `within` keeps those
 * under one folder of the zip.
 */
export function readSkills(fileName: string, bytes: Uint8Array, within = ''): FoundSkill[] {
  const base = baseName(fileName)
  if (!isZip(bytes)) return [loneSkill(bytes, base)]
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new HTTPException(400, { message: 'That zip could not be read' })
  }
  return skillsIn(base, entries, within)
}

/**
 * The same, read from a stream (an upload in the bucket), never held whole: a zip is
 * unpacked as it comes, keeping only the files a skill would keep, at most SKILL_PACK_MAX
 * bytes of them unpacked (a zip bomb is refused). A SKILL.md is at most SKILL_FILE_MAX.
 */
export async function readSkillsStream(
  fileName: string,
  stream: ReadableStream<Uint8Array>,
): Promise<FoundSkill[]> {
  const base = baseName(fileName)
  const reader = stream.getReader()
  // Its first bytes tell a zip from a SKILL.md.
  const first: Uint8Array[] = []
  let read = 0
  let done = false
  while (read < 2 && !done) {
    const next = await reader.read()
    if (next.done) {
      done = true
    } else {
      first.push(next.value)
      read += next.value.byteLength
    }
  }
  const head = Buffer.concat(first)
  const tooLarge = () => {
    void reader.cancel().catch(() => undefined)
    return new HTTPException(413, { message: 'Skills to import can be up to 50 MB unpacked' })
  }
  if (!isZip(head)) {
    const chunks: Uint8Array[] = [head]
    while (read <= SKILL_FILE_MAX && !done) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
      read += next.value.byteLength
    }
    if (read > SKILL_FILE_MAX) {
      void reader.cancel().catch(() => undefined)
      throw new HTTPException(413, { message: 'A SKILL.md can be up to 10 MB' })
    }
    return [loneSkill(Buffer.concat(chunks), base)]
  }
  // Kept files by path, in the zip's order; null for one too large to keep.
  const entries: Record<string, Uint8Array | null> = {}
  let kept = 0
  let failed = null as 'zip' | 'size' | null
  const unzip = new Unzip((file) => {
    if (ignored(file.name)) return
    const isEntry = file.name === SKILL_ENTRY || file.name.endsWith(`/${SKILL_ENTRY}`)
    const parts: Uint8Array[] = []
    let size = 0
    entries[file.name] = null
    file.ondata = (error, chunk, final) => {
      if (error) {
        failed ??= 'zip'
        return
      }
      size += chunk.byteLength
      kept += chunk.byteLength
      if (kept > SKILL_PACK_MAX) {
        failed ??= 'size'
        file.terminate()
        return
      }
      // A file too large is named among those left out, its bytes not kept.
      if (!isEntry && size > SKILL_FILE_MAX) {
        kept -= size
        parts.length = 0
        file.terminate()
        return
      }
      parts.push(chunk)
      if (final) entries[file.name] = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    }
    try {
      file.start()
    } catch {
      // A compression it cannot unpack: left out.
    }
  })
  unzip.register(UnzipInflate)
  try {
    unzip.push(head, done)
    while (!done && !failed) {
      const next = await reader.read()
      if (next.done) {
        unzip.push(new Uint8Array(0), true)
        break
      }
      unzip.push(next.value)
    }
  } catch {
    failed ??= 'zip'
  }
  if (failed === 'size') throw tooLarge()
  if (failed) {
    void reader.cancel().catch(() => undefined)
    throw new HTTPException(400, { message: 'That zip could not be read' })
  }
  return skillsIn(base, entries, '')
}

/** The skills in a zip's files (null: one too large to keep, named among those left out). */
function skillsIn(
  base: string,
  entries: Record<string, Uint8Array | null>,
  within: string,
): FoundSkill[] {
  const prefix = within ? `${within.replace(/^\/+|\/+$/g, '')}/` : ''
  const paths = Object.keys(entries).filter((p) => !ignored(p) && p.startsWith(prefix))
  const roots = paths
    .filter((p) => p === SKILL_ENTRY || p.endsWith(`/${SKILL_ENTRY}`))
    .map((p) => p.slice(0, -SKILL_ENTRY.length))
    .sort((a, b) => a.localeCompare(b))
  if (roots.length === 0)
    throw new HTTPException(400, {
      message: within ? `No ${SKILL_ENTRY} under ${within}` : `No ${SKILL_ENTRY} in it`,
    })
  // A file belongs to the deepest skill folder that holds it.
  const owner = (path: string) =>
    roots.filter((r) => path.startsWith(r)).sort((a, b) => b.length - a.length)[0]
  return roots.map((root) => {
    const entry = entries[`${root}${SKILL_ENTRY}`]
    const markdown = (entry && decode(entry)) ?? ''
    const files: FoundSkill['files'] = []
    const skipped: string[] = []
    for (const path of paths) {
      if (path === `${root}${SKILL_ENTRY}` || owner(path) !== root) continue
      const relative = path.slice(root.length)
      const file = entries[path]
      if (!file || file.byteLength > SKILL_FILE_MAX || files.length >= SKILL_FILES_MAX) {
        skipped.push(relative)
        continue
      }
      files.push({ path: relative, bytes: file })
    }
    const folder = root.replace(/\/$/, '')
    return fromMarkdown(markdown, folder, folder.split('/').pop() || base, files, skipped)
  })
}

function fromMarkdown(
  markdown: string,
  folder: string,
  fallbackName: string,
  files: FoundSkill['files'],
  skipped: string[],
): FoundSkill {
  const parsed = parseSkillMarkdown(markdown)
  return {
    folder,
    name: skillSlug(parsed.name ?? fallbackName),
    description: parsed.description ?? '',
    instructions: parsed.instructions,
    files,
    skipped,
  }
}

// ---------------------------------------------------------------------------
// From GitHub
// ---------------------------------------------------------------------------

/** A repository, its branch or tag (default when unset), and a folder in it. */
export type GitHubSource = { owner: string; repo: string; ref?: string; path: string }

/**
 * Read a GitHub address: a repository, a folder of one (`/tree/<ref>/<path>`),
 * or a SKILL.md in one (`/blob/<ref>/<path>/SKILL.md`). A ref with a slash in
 * it is read as its first part.
 */
export function parseGitHubUrl(url: string): GitHubSource | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  const [owner, rawRepo, kind, ref, ...rest] = parts
  if (!owner || !rawRepo) return null
  const repo = rawRepo.replace(/\.git$/, '')
  const safe = /^[A-Za-z0-9_.-]{1,100}$/
  if (!safe.test(owner) || !safe.test(repo)) return null
  if (!kind) return { owner, repo, path: '' }
  if ((kind !== 'tree' && kind !== 'blob') || !ref) return null
  let path = rest.join('/')
  if (kind === 'blob') path = path.replace(new RegExp(`(^|/)${SKILL_ENTRY}$`), '')
  return { owner, repo, ref, path }
}

/** How the source is kept on a pack: importing the same address again updates it. */
export const githubSourceKey = (s: GitHubSource) =>
  `https://github.com/${s.owner}/${s.repo}`.toLowerCase() +
  (s.ref ? `/tree/${s.ref}${s.path ? `/${s.path}` : ''}` : s.path ? `/tree/HEAD/${s.path}` : '')

/** At most this much of a repository's archive is read, compressed, to find a folder in it. */
const GITHUB_ARCHIVE_MAX = 2 * 1024 ** 3

/**
 * The skills in a GitHub repository, or in a folder of one, at that ref (its default
 * branch when unset), their folders from the repository's root. The repository's
 * tarball is read as it streams, keeping only the files under the folder, so a large
 * repository holding a small skill imports: at most SKILL_PACK_MAX bytes are kept.
 * A public one comes from codeload.github.com, as a browser's "Download ZIP" does: the
 * API allows 60 requests an hour per address without a login, which a server many
 * people share uses up. A private one comes through the API, with the workspace's
 * GitHub connection.
 */
export async function readGitHubSkills(source: GitHubSource, token?: string) {
  const ref = source.ref ?? 'HEAD'
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.split('/').includes('..'))
    throw new HTTPException(400, { message: 'That branch or tag name is not one GitHub uses' })
  const response = await fetch(
    token
      ? `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${ref}`
      : `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${ref}`,
    {
      headers: {
        'user-agent': 'Brigade',
        ...(token
          ? { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` }
          : {}),
      },
      redirect: 'follow',
    },
  )
  if (response.status === 404)
    throw new HTTPException(404, {
      message: token
        ? 'That repository or branch was not found'
        : 'That repository or branch was not found. A private one needs a GitHub connection that reaches it.',
    })
  if (response.status === 403 || response.status === 429)
    throw new HTTPException(503, {
      message: 'GitHub is limiting downloads from Brigade right now. Try again in a few minutes.',
    })
  if (!response.ok || !response.body)
    throw new HTTPException(502, { message: `GitHub did not send it (${response.status})` })
  const tooLarge = new HTTPException(413, { message: 'That repository is too large to import' })
  if (Number(response.headers.get('content-length') ?? 0) > GITHUB_ARCHIVE_MAX) {
    void response.body.cancel().catch(() => undefined)
    throw tooLarge
  }
  let downloaded = 0
  const capped = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      downloaded += chunk.byteLength
      if (downloaded > GITHUB_ARCHIVE_MAX) controller.error(tooLarge)
      else controller.enqueue(chunk)
    },
  })
  const tar = response.body
    .pipeThrough(capped)
    .pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
  let entries: Record<string, Uint8Array | null>
  try {
    entries = await readTarball(tar, source.path)
  } catch (error) {
    if (downloaded > GITHUB_ARCHIVE_MAX) throw tooLarge
    if (error instanceof HTTPException) throw error
    throw new HTTPException(502, { message: "GitHub's copy of that repository could not be read" })
  }
  return skillsIn(source.repo, entries, source.path)
}

/**
 * The files of a repository's tarball under `within` (all when empty), by their path
 * from the repository's root (a tarball holds everything under one folder,
 * `<owner>-<repo>-<sha>/`), read as it streams. Null: one too large to keep.
 */
export async function readTarball(
  stream: ReadableStream<Uint8Array>,
  within = '',
): Promise<Record<string, Uint8Array | null>> {
  const prefix = within ? `${within.replace(/^\/+|\/+$/g, '')}/` : ''
  const input = blocks(stream)
  const entries: Record<string, Uint8Array | null> = {}
  let kept = 0
  let longPath: string | undefined
  try {
    for (;;) {
      const header = await input.read(512)
      if (!header || header.every((b) => b === 0)) break
      const size = tarNumber(header.subarray(124, 136))
      const padded = Math.ceil(size / 512) * 512
      const type = String.fromCharCode(header[156] ?? 0)
      if (type === 'x' || type === 'L') {
        // A long path: a pax record (`<length> path=<path>\n`) or GNU's own.
        const data = await input.read(padded)
        if (!data) break
        const body = tarString(data.subarray(0, size))
        longPath = type === 'L' ? body : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(body)?.[1] ?? longPath)
        continue
      }
      const ustar = tarString(header.subarray(257, 262)) === 'ustar'
      const name = tarString(header.subarray(0, 100))
      const prefixField = ustar ? tarString(header.subarray(345, 500)) : ''
      const full = longPath ?? (prefixField ? `${prefixField}/${name}` : name)
      longPath = undefined
      // The repository's own path: past its top folder.
      const path = full.slice(full.indexOf('/') + 1)
      const regular = type === '0' || type === '\0'
      if (!regular || !full.includes('/') || !path.startsWith(prefix) || ignored(path)) {
        if (!(await input.skip(padded))) break
        continue
      }
      const isEntry = path === SKILL_ENTRY || path.endsWith(`/${SKILL_ENTRY}`)
      if (!isEntry && size > SKILL_FILE_MAX) {
        entries[path] = null
        if (!(await input.skip(padded))) break
        continue
      }
      kept += size
      if (kept > SKILL_PACK_MAX)
        throw new HTTPException(413, {
          message: within
            ? 'That folder is too large to import (50 MB)'
            : 'That repository is too large to import (50 MB): give the address of the folder its skills are in',
        })
      const data = await input.read(padded)
      if (!data) break
      entries[path] = data.slice(0, size)
    }
  } finally {
    input.cancel()
  }
  return entries
}

/** A stream read by exact lengths. */
function blocks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let chunk: Uint8Array = new Uint8Array(0)
  let offset = 0
  const fill = async () => {
    while (offset >= chunk.byteLength) {
      const next = await reader.read()
      if (next.done) return false
      chunk = next.value
      offset = 0
    }
    return true
  }
  return {
    /** The next `length` bytes, or null when the stream ends first. */
    async read(length: number) {
      const parts: Uint8Array[] = []
      let left = length
      while (left > 0) {
        if (!(await fill())) return null
        const take = Math.min(left, chunk.byteLength - offset)
        parts.push(chunk.subarray(offset, offset + take))
        offset += take
        left -= take
      }
      return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    },
    /** Past the next `length` bytes, unread; false when the stream ends first. */
    async skip(length: number) {
      let left = length
      while (left > 0) {
        if (!(await fill())) return false
        const take = Math.min(left, chunk.byteLength - offset)
        offset += take
        left -= take
      }
      return true
    },
    cancel: () => void reader.cancel().catch(() => undefined),
  }
}

const latin = new TextDecoder('utf-8')
const tarString = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0)
  return latin.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

/** A size: octal text, or base-256 when its first bit is set. */
function tarNumber(bytes: Uint8Array) {
  if ((bytes[0] ?? 0) & 0x80) {
    let n = (bytes[0] ?? 0) & 0x7f
    for (const b of bytes.subarray(1)) n = n * 256 + b
    return n
  }
  return Number.parseInt(tarString(bytes).trim() || '0', 8)
}
