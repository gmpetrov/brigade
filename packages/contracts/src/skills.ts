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
/** Limits a skill stays within: the harness loads it whole into the teammate's context. */
export const SKILL_INSTRUCTIONS_MAX = 60_000
export const SKILL_FILES_MAX = 40
export const SKILL_FILE_MAX = 200_000
export const SKILL_TOTAL_MAX = 1_000_000

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

export const SkillFile = z.object({
  path: SkillFilePath,
  content: z.string().max(SKILL_FILE_MAX),
})
export type SkillFile = z.infer<typeof SkillFile>

/** What a skill says: Grok's three fields, plus the files a SKILL.md folder may carry. */
export const SkillContent = z
  .object({
    name: SkillName,
    /** When to use it: the teammate reads this to decide. */
    description: z.string().trim().min(1).max(1024),
    instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX),
    files: z.array(SkillFile).max(SKILL_FILES_MAX).default([]),
  })
  .refine((s) => new Set(s.files.map((f) => f.path)).size === s.files.length, {
    message: 'two files have the same path',
    path: ['files'],
  })
  .refine(
    (s) =>
      s.instructions.length + s.files.reduce((sum, f) => sum + f.content.length, 0) <=
      SKILL_TOTAL_MAX,
    { message: 'the skill is too large', path: ['files'] },
  )
export type SkillContent = z.infer<typeof SkillContent>

/** Where a skill applies: every thread, or those of some teammates or projects. */
export const SkillScope = z.object({
  everywhere: z.boolean().default(true),
  teammateIds: z.array(z.string()).max(200).default([]),
  projectIds: z.array(z.string()).max(200).default([]),
})
export type SkillScope = z.infer<typeof SkillScope>

/** The body to create or change a skill from the dashboard. */
export const SaveSkill = z.intersection(
  SkillContent,
  SkillScope.extend({ enabled: z.boolean().default(true) }),
)
export type SaveSkill = z.infer<typeof SaveSkill>

/** A skill as the dashboard shows it. */
export const Skill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(SkillFile),
  everywhere: z.boolean(),
  teammateIds: z.array(z.string()),
  projectIds: z.array(z.string()),
  enabled: z.boolean(),
  /** Who wrote or last changed it: a member, or a teammate whose proposal a person approved. */
  updatedBy: z.object({ type: z.enum(['member', 'teammate']), name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Skill = z.infer<typeof Skill>

/** A skill in a thread's spec: what the runner writes into the teammate's skills folder. */
export const ThreadSkill = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(SkillFile).default([]),
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
}
