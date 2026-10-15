// Importing a skill made elsewhere (Claude, Codex, Grok, a repository): a
// SKILL.md, or a zip of its folder. Read for a person to review; never saved here.
import {
  SKILL_ENTRY,
  SKILL_FILE_MAX,
  SKILL_FILES_MAX,
  parseSkillMarkdown,
  skillSlug,
  type SkillFile,
} from '@brigade/contracts'
import { unzipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'

/** What an upload holds, for a person to review before saving: never saved here. */
export type ImportedSkill = {
  name: string
  description: string
  instructions: string
  files: SkillFile[]
  /** Files left out: not text, too large, or past the limit. */
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

/** Read a SKILL.md, or a zip of a skill folder (Claude's `.skill` files are zips). */
export function importSkill(fileName: string, bytes: Uint8Array): ImportedSkill {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(md|zip|skill)$/i, '')
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (!isZip) {
    const markdown = decode(bytes)
    if (markdown === null)
      throw new HTTPException(400, {
        message: 'Upload a SKILL.md, or a .zip or .skill of its folder',
      })
    return fromMarkdown(markdown, base === 'SKILL' ? '' : base, [], [])
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new HTTPException(400, { message: 'That zip could not be read' })
  }
  const paths = Object.keys(entries).filter(
    (p) =>
      !p.endsWith('/') &&
      !p.startsWith('__MACOSX/') &&
      !p.split('/').some((s) => s.startsWith('.')),
  )
  // The shallowest SKILL.md is the skill; its folder holds the rest.
  const entry = paths
    .filter((p) => p === SKILL_ENTRY || p.endsWith(`/${SKILL_ENTRY}`))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (!entry) throw new HTTPException(400, { message: `The zip has no ${SKILL_ENTRY}` })
  const root = entry.slice(0, -SKILL_ENTRY.length)
  const markdown = decode(entries[entry]!)
  if (markdown === null) throw new HTTPException(400, { message: `${SKILL_ENTRY} is not text` })
  const files: SkillFile[] = []
  const skipped: string[] = []
  for (const path of paths) {
    if (path === entry || !path.startsWith(root)) continue
    const relative = path.slice(root.length)
    const content = decode(entries[path]!)
    if (content === null || content.length > SKILL_FILE_MAX || files.length >= SKILL_FILES_MAX)
      skipped.push(relative)
    else files.push({ path: relative, content })
  }
  const folder = root.replace(/\/$/, '').split('/').pop() ?? ''
  return fromMarkdown(markdown, folder || base, files, skipped)
}

function fromMarkdown(
  markdown: string,
  fallbackName: string,
  files: SkillFile[],
  skipped: string[],
) {
  const parsed = parseSkillMarkdown(markdown)
  return {
    name: skillSlug(parsed.name ?? fallbackName),
    description: parsed.description ?? '',
    instructions: parsed.instructions,
    files,
    skipped,
  }
}
