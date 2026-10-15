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
- **Text in the database, files in the bucket, not the library.** `Skill` holds the
  name, description and instructions, and refs to its files (`[{ path, sha256, size }]`),
  whose bytes are in the bucket at `<org>/<workspace>/skill-files/<sha256>`, kept once
  whatever the skill. Not the library: any member may edit a library file, so a skill
  there could change without an admin and drift from its row. Skills saved before files
  moved to the bucket (`[{ path, content }]`) move on the next list of skills.
- **A thread gets refs, the runner the bytes.** `ThreadSpec.skills[].refs` names each file;
  the runner fetches it from `/runner/skill-files/<sha256>` (its own workspace's only),
  checks the hash and caches it like attachments. Inline `files` stay for runners before
  protocol 21.
- **Packs.** Skills imported together (`SkillPack`: a GitHub address, or `file:<name>` for
  an upload) have one scope, written onto their skills, and one switch over theirs: a skill
  is given to teammates when its own switch and its pack's are on. Importing the same
  source again updates the pack: changed skills update, new ones are added, the switches
  stay; skills the source no longer has stay too. A skill outside the pack with the same
  name is never taken over.
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
- **Import, never sync.** A `SKILL.md`, a `.zip` or `.skill` (one skill folder or many), or
  a GitHub repository or folder (`POST /api/skills/import`, `/import/github`; a private one
  through the workspace's GitHub connection) is read into skills to review: their files go
  to the bucket then, the skills only once someone adds them. One new skill opens in the
  editor; several, or an update of a pack, in a checklist whose ticks are the switches.
  Files over 10 MB, and past 200 per skill, are left out and listed; uploads up to 50 MB.

## Where

- Contracts: `packages/contracts/src/skills.ts` (schemas, SKILL.md read and write),
  `commands.ts` (`skillCommand`, `commandPrompt`).
- API: `apps/api/src/skills.ts`, `skill-import.ts`, `routes/skills.ts`,
  `routes/runner-skill-files.ts`; the spec in
  `thread-spec.ts`; proposals in `library-calls.ts` and `decide.ts`.
- Runner: `apps/runner/src/skills.ts` (writing them), `instructions.ts` (Brigade's own
  skills and the Skills section), `harness/tools.ts` (`propose_skill`).
- Web: `components/skills.tsx` on the Connections page, the composer's `/` menu, and
  skill proposals in `ticket-row.tsx`.
