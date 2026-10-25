# Playbooks shipped with the API

Each folder is a playbook template: its `playbook.yaml` (`PlaybookManifest` in
`@brigade/contracts`), its recipe as skills in `skills/<name>/SKILL.md`, and examples in
`samples/` for dry runs. Its id is `brigade/<folder>`.

`scripts/playbooks.mjs` turns the folders into `src/generated/playbooks.ts` (the API runs on Workers,
which have no files); `build`, `typecheck`, `dev` and `test` run it. `src/playbooks.ts` checks each
manifest when the API loads it, and `test/playbooks.test.ts` checks every template here.

## Teammates

A template may split its work between teammates. Each is a setting of type `teammate`, always
asked; the manifest's `teammate` names the one its runs start with (its triggers and schedules
start that teammate's threads), and an App with `teammate: <key>` belongs to another:

```yaml
teammate: support
apps:
  - { kind: gmail, access: read_write }
  - { kind: github, access: read_write, teammate: developer }
settings:
  - { key: support, type: teammate, ask: 'Which teammate answers the customers?' }
  - { key: developer, type: teammate, ask: 'Which teammate fixes the bugs in the code?' }
```

A thread has its own teammate's Apps alone, whatever that teammate's grants: the run's thread
those with no `teammate`, a child started with `start_child({ teammate: 'developer' })` those of
`developer` (`Session.playbookTeammate`). The same teammate may hold several; each thread is still
kept to its own Apps, and git refuses a thread without GitHub. A template without teammate settings
gives every thread every App, on the teammate it is installed for.

## Versions and updates

Raise `version` (semver) with every change to a template. An installation keeps the manifest it
was installed with; when its template is newer, its sheet on Routines shows "Version 1.0.0 · 1.3.0
available" and an Update button (its owner, an owner or an admin), and a person can also ask the
chief in a chat (`update_playbook`). `src/playbook-updates.ts` compares the two versions and moves
it in place (`POST /playbooks/:id/update`):

- Its answers are kept and removed settings dropped. The setting its runs start with (`teammate`)
  defaults to the teammate it runs for; any other new required setting needs an answer first, and
  until it has one nothing changes.
- An entry at the same index that is still the same trigger (same `app.event` and account), or
  still a schedule, changes in place: a Gmail trigger keeps its id, so its inbox subscription and
  cursor stay (no mail missed or replayed). Other entries are added or removed.
- Its skills take the new version's content, except one the workspace edited since Brigade wrote
  it (a `skill.updated` in the audit log): kept unless the person chooses the new one.
- Autonomy never grows. An unchanged action keeps its level, conditions, caps and history; one whose
  `tools` or `conditions` change goes back to asking (`demotedReason: update`) and its trust counts
  again from then; a new one starts at its `start` but no higher than asking; a level above a
  lowered `ceiling` is capped; a removed action goes.
- Its runs, numbers, approvals and dry runs stay, and so does its status (active or paused).

One still in setup or a dry run moves to the latest version by itself when its installation goes on
in the chat, its parts made again.
