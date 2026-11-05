// Brigade's own skills (docs/skills.md): how teammates make designs, run previews, learn a task
// and keep a project's documents. The runner writes them into every thread beside the workspace's
// own; names starting with `brigade-` are reserved for them. Settings › Skills lists them,
// read-only, and an admin may turn off those marked `switchable` for the workspace.
import { z } from 'zod'
import { BUILTIN_SKILL_PREFIX } from './skills.js'

export const LIBRARY_SKILL_NAME = `${BUILTIN_SKILL_PREFIX}library`

/** How a project's documents are filed: specs, designs and their status (docs/projects.md). */
export const LIBRARY_SKILL = {
  name: LIBRARY_SKILL_NAME,
  description:
    "How to file and keep a project's documents in the library: specs, notes, designs and " +
    'investigations, and their status. Read before writing or saving a spec, note or design for a ' +
    "project, when a pull request ships or changes one, or when tidying a project's folder.",
  instructions: `# A project's documents

A project's documents are of two kinds, kept apart:

- **Decisions** (a spec, a proposal, a note): what was chosen and why, at a date. Each has a status. Once shipped it is history: it is not kept in step with what was built.
- **Reference**: what is true today, with no status. It changes in the same step as the thing it describes: for a project with code, the repository's own docs (\`docs/\`, READMEs), changed in the same pull request as the code; for one without, the \`reference/\` folder of the project's library folder.

The truth is the reference, never a spec. Before saying a spec is or is not built, check the repository's merged pull requests: a status can be behind.

## Where things go

A project with fewer than about ten documents keeps them at the top of its folder. Once it has more, it gets these folders, and not before:

\`\`\`
<project folder>/
├─ decisions/       specs and notes, each with its status line
├─ designs/         one <feature>.design per feature
├─ reference/       what is true today (with code: a README that points to the repository's docs)
├─ investigations/  one-off investigations: a bug, a benchmark
└─ media/           screenshots, recordings
\`\`\`

- A short fact or a rule goes in memory, not in a document. A way of doing a kind of work is a skill.
- A document that fits none of these stays at the top of the folder, which serves as its inbox. Once two or three of the same kind gather there, make a folder named after that kind (\`research/\`, \`marketing/\`) and move them in. Never a catch-all folder such as \`misc/\` or \`other/\`.
- Folder and file names are kebab-case (\`child-threads-spec.md\`).
- Never write the same truth in two places: link to it.

## The status line

The third line of every spec or note (after its title and a blank line) gives its kind and date, then its status, always in English, whatever language the document is written in; what follows is in the document's language:

\`Spec, 2026-10-19. Status: draft. Proposed, not decided yet.\`

| Status | Meaning | The line also gives |
|---|---|---|
| draft | Under discussion | |
| accepted | Decided, not built | the date it was decided |
| shipped | Built | the pull requests, and where the reference now lives |
| paused | Set aside for now | why, and what would bring it back |
| dropped | Will not be done | why |
| superseded | Another document takes over | that document (\`superseded by …\`) |

No other words, and no other form: Brigade reads this line to show the project's Decisions, and a line it cannot read shows as "No status".

A design's status is in its \`design.json\`: \`"status": "draft"\`, with the same words, and \`"pullRequests": [241]\` once built. A design is a decision too: once shipped, the product is the reference.

## As the work goes

1. **New**: write it as \`draft\` and save it.
2. **Decided**: set \`accepted\`, with the date.
3. **Built**: when you open the pull request that builds it, name it in the pull request's \`specs\`: \`ships\` for the specs and designs it builds whole, \`partOf\` for those it is one step of. Brigade marks each one it ships \`shipped\` with the pull request's number once it is merged, and names the pull request on the others. In that same pull request, update the repository's docs to describe what was built. Once it is merged, add that reference to the spec's line, its path in backticks, as in: Status: shipped (#241). Reference: \`docs/lists.md\`.
4. **Changed after shipping**: do not rewrite a shipped spec. Write a new one, and add a line to the old one pointing to it.
5. **Paused, dropped or replaced**: set the status, with the reason or the document that takes over.

## Moving files

Move and rename with \`move_in_library\`. Moving does not change the documents or memory that name the old path: fix those that matter. Delete only notes that do nothing but point elsewhere; ask before deleting anything else.
`,
} as const

/** One of Brigade's own skills, as Settings › Skills lists it. */
export type BuiltinSkillEntry = {
  name: string
  description: string
  /** Whether an admin may turn it off for the workspace; the others are always on. */
  switchable: boolean
}

/**
 * Brigade's own skills, in the order Settings › Skills lists them. The runner builds the others'
 * instructions for each thread (apps/runner/src/instructions.ts); their names and descriptions
 * are these.
 */
export const BUILTIN_SKILLS: BuiltinSkillEntry[] = [
  { name: LIBRARY_SKILL.name, description: LIBRARY_SKILL.description, switchable: true },
  {
    name: `${BUILTIN_SKILL_PREFIX}designs`,
    description:
      'Make, change, check and save a visual design (a page, a screen, a prototype, slides, a one-pager) as ' +
      'a web page in the library; answer comments on one; pick its design system. Read before any design work.',
    switchable: false,
  },
  {
    name: `${BUILTIN_SKILL_PREFIX}design-systems`,
    description:
      'Make a design system (from a repository, a site, an export or a brief) and register it with ' +
      'save_design_system. Read when asked for a design system.',
    switchable: false,
  },
  {
    name: `${BUILTIN_SKILL_PREFIX}previews`,
    description:
      'Start, set up, check, fix and save a preview of an app (start_preview, check_preview, save_preview, ' +
      'preview_logs, preview variables). Read before starting a preview.',
    switchable: false,
  },
  {
    name: `${BUILTIN_SKILL_PREFIX}teach`,
    description:
      'Learn a task from a recording a person made with Teach a task (a `/teach` message with a video and a ' +
      'demonstration zip), and propose it as a skill of your own. Read when a message asks you to learn from a demonstration.',
    switchable: false,
  },
]

export const builtinSkillDescription = (name: string) =>
  BUILTIN_SKILLS.find((s) => s.name === name)?.description ?? ''

/** A built-in skill in Settings › Skills: whether it is on here, and who last turned it off. */
export const BuiltinSkillView = z.object({
  name: z.string(),
  description: z.string(),
  switchable: z.boolean(),
  enabled: z.boolean(),
  /** Its instructions, when they are the same in every thread; else null. */
  instructions: z.string().nullable(),
  /** Who turned it off, while it is off. */
  offBy: z.object({ name: z.string(), at: z.string() }).nullable(),
})
export type BuiltinSkillView = z.infer<typeof BuiltinSkillView>

export const SetBuiltinSkill = z.object({ enabled: z.boolean() })
