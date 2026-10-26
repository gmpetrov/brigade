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

/**
 * The repository's zip at that ref (its default branch when unset). A public
 * one comes from codeload.github.com, as a browser's "Download ZIP" does: the
 * API allows 60 requests an hour per address without a login, which a server
 * many people share uses up. A private one comes through the API, with the
 * workspace's GitHub connection.
 */
export async function fetchGitHubZip(source: GitHubSource, token?: string) {
  const ref = source.ref ?? 'HEAD'
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.split('/').includes('..'))
    throw new HTTPException(400, { message: 'That branch or tag name is not one GitHub uses' })
  const response = await fetch(
    token
      ? `https://api.github.com/repos/${source.owner}/${source.repo}/zipball/${ref}`
      : `https://codeload.github.com/${source.owner}/${source.repo}/zip/${ref}`,
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
  if (!response.ok)
    throw new HTTPException(502, { message: `GitHub did not send it (${response.status})` })
  if (Number(response.headers.get('content-length') ?? 0) > SKILL_PACK_MAX)
    throw new HTTPException(413, { message: 'That repository is too large to import (50 MB)' })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > SKILL_PACK_MAX)
    throw new HTTPException(413, { message: 'That repository is too large to import (50 MB)' })
  return bytes
}

/** A repository's zip holds everything under one folder: `<repo>-<ref>/`, or `<owner>-<repo>-<sha>/`. */
export function zipballRoot(bytes: Uint8Array) {
  let root = ''
  // Names only: nothing is unpacked.
  unzipSync(bytes, {
    filter: (file) => {
      root ||= file.name.split('/')[0] ?? ''
      return false
    },
  })
  return root
}
