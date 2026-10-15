# Skills

A skill says how the workspace does a kind of work: release notes, issue triage, a weekly
digest. It is a `SKILL.md` (frontmatter `name` and `description`, then the instructions)
and the text files beside it: the open Agent Skills format Claude Code, Codex and Grok
read. Memory holds facts and is always loaded; only a skill's name and description are,
until the work calls for it.

## Decisions

- **The workspace's, not a person's.** Teammates are shared, so their skills are too. A
  skill applies to every thread, or only to those of some teammates or projects (the same
  scoping as design systems, without repositories: a repository keeps its own skills in
  its `.claude/skills/` or `.agents/skills/`, which the teammate reads after checking it
  out, like its AGENTS.md).
- **Owners and admins write them.** A skill changes what every teammate does, like a
  policy. Members see them and use them as `/name` in the composer.
- **Teammates propose; an admin approves.** `propose_skill` reads a folder the teammate
  wrote and opens an `approval` ticket with the skill in its payload (`skillAction`). It
  does not wait: approving saves the skill (`decideSkillProposal`), for threads that start
  after. A new proposal for the same name replaces an open one. Scripts in a skill are not
  the risk (they run in the teammate's sandbox and get no credentials); behaviour is, so
  every proposal is approved, scripts or not.
- **A skill gives no access.** Connections, credentials and grants stay where they are.
- **Text in the database, not the library.** `Skill` holds the instructions and the files
  (text only, size-capped), so a thread gets them whole in its spec (`ThreadSpec.skills`)
  with no library grant or mirror involved.
- **The harness loads them.** As a session starts, the runner writes Brigade's own skills
  and the workspace's into `<working directory>/.claude/skills/<name>/` (Claude Code) or
  `.agents/skills/<name>/` (Codex), beside the CLAUDE.md or AGENTS.md it writes there.
  A manifest (`.brigade-skills.json`) names the folders Brigade wrote, so it replaces only
  those; a folder the teammate made keeps its name. Per thread, not in the teammate's
  home: threads of one teammate in different projects get different skills.
- **Brigade's own instructions are skills too.** How to make designs, design systems and
  previews (`brigade-designs`, `brigade-design-systems`, `brigade-previews`) left the
  generated CLAUDE.md, which keeps a line saying when to read each. Names starting with
  `brigade-` are reserved, as are the names of Brigade's own commands (`/design`, `/visual`, `/image`).
- **Import, never sync.** A `SKILL.md`, `.zip` or `.skill` (Claude's export, a zip) is read
  into the editor to review before saving (`POST /api/skills/import`); binaries are left
  out and listed.

## Where

- Contracts: `packages/contracts/src/skills.ts` (schemas, SKILL.md read and write),
  `commands.ts` (`skillCommand`, `commandPrompt`).
- API: `apps/api/src/skills.ts`, `skill-import.ts`, `routes/skills.ts`; the spec in
  `thread-spec.ts`; proposals in `library-calls.ts` and `decide.ts`.
- Runner: `apps/runner/src/skills.ts` (writing them), `instructions.ts` (Brigade's own
  skills and the Skills section), `harness/tools.ts` (`propose_skill`).
- Web: `components/skills.tsx` on the Connections page, the composer's `/` menu, and
  skill proposals in `ticket-row.tsx`.
