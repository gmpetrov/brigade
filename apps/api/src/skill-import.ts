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
import { unzipSync } from 'fflate'
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

/**
 * Every skill in a SKILL.md or a zip (Claude's `.skill` files are zips), its
 * files those under its folder that no deeper skill holds. `within` keeps those
 * under one folder of the zip.
 */
export function readSkills(fileName: string, bytes: Uint8Array, within = ''): FoundSkill[] {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(md|zip|skill)$/i, '')
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (!isZip) {
    const markdown = decode(bytes)
    if (markdown === null)
      throw new HTTPException(400, {
        message: 'Upload a SKILL.md, or a .zip or .skill of a skill folder or of many',
      })
    return [fromMarkdown(markdown, '', base === 'SKILL' ? '' : base, [], [])]
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new HTTPException(400, { message: 'That zip could not be read' })
  }
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
    const markdown = decode(entries[`${root}${SKILL_ENTRY}`]!) ?? ''
    const files: FoundSkill['files'] = []
    const skipped: string[] = []
    for (const path of paths) {
      if (path === `${root}${SKILL_ENTRY}` || owner(path) !== root) continue
      const relative = path.slice(root.length)
      const file = entries[path]!
      if (file.byteLength > SKILL_FILE_MAX || files.length >= SKILL_FILES_MAX) {
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
 * The repository's zip at that ref: with the workspace's GitHub connection when
 * it reaches the repository (a private one), else as anyone would.
 */
export async function fetchGitHubZip(source: GitHubSource, token?: string) {
  const ref = source.ref ? `/${encodeURIComponent(source.ref)}` : ''
  const response = await fetch(
    `https://api.github.com/repos/${source.owner}/${source.repo}/zipball${ref}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Brigade',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'follow',
    },
  )
  if (response.status === 404)
    throw new HTTPException(404, {
      message: token
        ? 'That repository or branch was not found'
        : 'That repository was not found. A private one needs a GitHub connection that reaches it.',
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

/** A zipball holds everything under one `<owner>-<repo>-<sha>/` folder. */
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
