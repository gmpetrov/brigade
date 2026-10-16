// Skills: how to do a kind of work, written once and loaded by a teammate
// when the work calls for it (the open SKILL.md standard Claude Code and Codex
// read). Memory holds facts and is always loaded; a skill holds a procedure
// and only its name and description are, until it is needed. A skill gives no
// access: connections and credentials stay with their grants.
import { z } from 'zod'
import { MESSAGE_COMMANDS } from './commands.js'

/** The file the harnesses read: frontmatter (name, description), then the instructions. */
export const SKILL_ENTRY = 'SKILL.md'
/** Skills Brigade ships are named with this; a workspace skill may not be. */
export const BUILTIN_SKILL_PREFIX = 'brigade-'
/** Its instructions, read only when the work calls for the skill: real ones run long. */
export const SKILL_INSTRUCTIONS_MAX = 500_000
/** Its description, in every thread's list of skills: real ones run to a paragraph. */
export const SKILL_DESCRIPTION_MAX = 4_000
/** The files beside SKILL.md, kept in the bucket: scripts, templates, fonts. */
export const SKILL_FILES_MAX = 200
export const SKILL_FILE_MAX = 10 * 1024 * 1024
export const SKILL_TOTAL_MAX = 25 * 1024 * 1024
/** A teammate's proposal carries its files as text, in its ticket. */
export const SKILL_TEXT_FILES_MAX = 40
export const SKILL_TEXT_FILE_MAX = 200_000
/** The largest pack to import: a zip, or a GitHub repository's. */
export const SKILL_PACK_MAX = 50 * 1024 * 1024

/** A slug, as the harnesses and the composer's `/` name it. */
export const SkillName = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words joined by hyphens, e.g. release-notes')
  .refine((name) => !name.startsWith(BUILTIN_SKILL_PREFIX), {
    message: `names starting with ${BUILTIN_SKILL_PREFIX} are Brigade's own`,
  })
  .refine((name) => !(name in MESSAGE_COMMANDS), {
    message: `/${Object.keys(MESSAGE_COMMANDS).join(' and /')} are Brigade's own commands`,
  })

/** Skill-relative POSIX path of a file beside SKILL.md, e.g. `reference.md` or `scripts/check.sh`. */
export const SkillFilePath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      path !== SKILL_ENTRY,
    { message: 'a relative path inside the skill, other than SKILL.md' },
  )

/** A text file, carried inline: in a teammate's proposal. */
export const SkillFile = z.object({
  path: SkillFilePath,
  content: z.string().max(SKILL_TEXT_FILE_MAX),
})
export type SkillFile = z.infer<typeof SkillFile>

/** A file kept in the bucket, by its SHA-256: any kind, text or not. */
export const SkillFileRef = z.object({
  path: SkillFilePath,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(0).max(SKILL_FILE_MAX),
})
export type SkillFileRef = z.infer<typeof SkillFileRef>

const uniquePaths = (files: { path: string }[]) =>
  new Set(files.map((f) => f.path)).size === files.length

/** Grok's three fields: what every skill says. */
const SkillText = z.object({
  name: SkillName,
  /** When to use it: the teammate reads this to decide. */
  description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX),
  instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX),
})

/** A skill a teammate proposes: its files as text, inline. */
export const SkillContent = SkillText.extend({
  files: z.array(SkillFile).max(SKILL_TEXT_FILES_MAX).default([]),
}).refine((s) => uniquePaths(s.files), {
  message: 'two files have the same path',
  path: ['files'],
})
export type SkillContent = z.infer<typeof SkillContent>

/** A skill as saved: its files in the bucket. */
export const SkillWithFiles = SkillText.extend({
  files: z.array(SkillFileRef).max(SKILL_FILES_MAX).default([]),
})
  .refine((s) => uniquePaths(s.files), {
    message: 'two files have the same path',
    path: ['files'],
  })
  .refine((s) => s.files.reduce((sum, f) => sum + f.size, 0) <= SKILL_TOTAL_MAX, {
    message: 'the skill is too large',
    path: ['files'],
  })
export type SkillWithFiles = z.infer<typeof SkillWithFiles>

/** Where a skill applies: every thread, or those of some teammates or projects. */
export const SkillScope = z.object({
  everywhere: z.boolean().default(true),
  teammateIds: z.array(z.string()).max(200).default([]),
  projectIds: z.array(z.string()).max(200).default([]),
})
export type SkillScope = z.infer<typeof SkillScope>

/** The body to create or change a skill from the dashboard. In a pack, its scope is the pack's. */
export const SaveSkill = z.intersection(
  SkillWithFiles,
  SkillScope.extend({ enabled: z.boolean().default(true) }),
)
export type SaveSkill = z.infer<typeof SaveSkill>

/** Skills imported together, kept as one: one scope, a switch for all, updated together. */
export const SkillPack = z.object({
  id: z.string(),
  name: z.string(),
  /** Where it came from: a GitHub address, or `file:<name>` for an upload. */
  source: z.string(),
  /** The App it came with: its key, a connector kind for a built-in App. */
  appKey: z.string().nullable().default(null),
  everywhere: z.boolean(),
  teammateIds: z.array(z.string()),
  projectIds: z.array(z.string()),
  /** Off turns all its skills off; on, each is as its own switch says. */
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SkillPack = z.infer<typeof SkillPack>

/** A pack's name, scope or switch. */
export const UpdateSkillPack = SkillScope.partial().extend({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
})
export type UpdateSkillPack = z.infer<typeof UpdateSkillPack>

/** One skill an import found, and what adding it would do. */
export const ImportedSkill = z.object({
  /** Its folder in the upload or repository, to tell skills apart. */
  folder: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(SkillFileRef),
  /** Files left out: too large, or past the limit. */
  skipped: z.array(z.string()),
  /**
   * new: not here yet. update / same: in this pack already, changed or not.
   * taken: a skill outside this pack has the name. invalid: cannot be added as it is.
   */
  status: z.enum(['new', 'update', 'same', 'taken', 'invalid']),
  problem: z.string().optional(),
  /** Its switch now, for one already in the pack. */
  enabled: z.boolean().optional(),
})
export type ImportedSkill = z.infer<typeof ImportedSkill>

/** What an upload or a GitHub address holds: nothing is saved yet, but its files are in the bucket. */
export const SkillImport = z.object({
  source: z.string(),
  /** A name for the pack: the repository's or the file's. */
  label: z.string(),
  /** The pack imported from the same source before, to update. */
  pack: SkillPack.nullable(),
  skills: z.array(ImportedSkill),
})
export type SkillImport = z.infer<typeof SkillImport>

/** Import from a GitHub repository or a folder of one. */
export const ImportSkillsFromUrl = z.object({ url: z.string().trim().url().max(500) })

/** Add the skills an import found as a pack, or update the pack. A skill's `enabled` is its switch. */
export const SaveSkillPack = SkillScope.extend({
  packId: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  source: z.string().trim().min(1).max(500),
  skills: z
    .array(z.intersection(SkillWithFiles, z.object({ enabled: z.boolean().default(true) })))
    .min(1)
    .max(200),
})
export type SaveSkillPack = z.infer<typeof SaveSkillPack>

/** A skill as the dashboard shows it. */
export const Skill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(SkillFileRef),
  everywhere: z.boolean(),
  teammateIds: z.array(z.string()),
  projectIds: z.array(z.string()),
  /** Its own switch. */
  enabled: z.boolean(),
  /** The pack it came in, if any: its scope and switch apply. */
  packId: z.string().nullable(),
  /** Teammates get it: its switch, and its pack's, are on. */
  active: z.boolean(),
  /** Who wrote or last changed it: a member, or a teammate whose proposal a person approved. */
  updatedBy: z
    .object({
      type: z.enum(['member', 'teammate']),
      id: z.string(),
      name: z.string(),
      /** A member's photo, from their sign-in. */
      image: z.string().nullable().default(null),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Skill = z.infer<typeof Skill>

/**
 * A skill in a thread's spec: what the runner writes into the teammate's skills
 * folder. Its files come from the bucket by their SHA-256 (`refs`); `files`,
 * inline text, is what runners before protocol 21 read.
 */
export const ThreadSkill = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(SkillFile).default([]),
  refs: z.array(SkillFileRef).default([]),
})
export type ThreadSkill = z.infer<typeof ThreadSkill>

/** A skill's SKILL.md: YAML frontmatter, then its instructions. */
export function skillMarkdown(skill: Pick<SkillContent, 'name' | 'description' | 'instructions'>) {
  const line = skill.description.replace(/\s+/g, ' ').trim()
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(line)}\n---\n\n${skill.instructions.trim()}\n`
}

/**
 * Read a SKILL.md: its frontmatter's name and description, and the rest as the
 * instructions. Values may be plain, quoted, or folded (`>` / `|`) YAML scalars.
 */
export function parseSkillMarkdown(text: string): {
  name?: string
  description?: string
  instructions: string
} {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (!m) return { instructions: normalized.trim() }
  const fields: Record<string, string> = {}
  const lines = m[1]!.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z_-]+):[ \t]*(.*)$/.exec(lines[i]!)
    if (!field) continue
    let value = field[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!))
        block.push(lines[++i]!.trim())
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim()
    } else if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string
      } catch {
        value = value.slice(1, -1)
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    fields[field[1]!.toLowerCase()] = value
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    instructions: normalized.slice(m[0].length).trim(),
  }
}

/** A name from free text: "Release notes!" -> "release-notes". */
export function skillSlug(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

/** The tool a teammate proposes a skill with; a person approves it before it applies. */
export const PROPOSE_SKILL_TOOL = 'propose_skill'

/** A teammate's proposal: a new skill, or a change to the one with that name. */
export const SkillProposal = z.object({
  skill: SkillContent,
  /** Why it is worth keeping: what work it came from. */
  reason: z.string().trim().max(1000).default(''),
  /** A new skill for the proposing teammate's threads only, not everywhere (a task it was taught). */
  teammateOnly: z.boolean().default(false),
})
export type SkillProposal = z.infer<typeof SkillProposal>

/** A skill proposal's ticket payload, as the dashboard reads it. */
export type SkillProposalPayload = {
  skillAction: 'create' | 'update'
  /** The skill it changes. */
  skillId?: string
  skill: SkillContent
  /** What the skill said before, for a change. */
  previous?: { description: string; instructions: string; files: string[] }
  teammateId: string
  reason?: string
  /** A new skill applies to `teammateId`'s threads only. */
  teammateOnly?: boolean
}
