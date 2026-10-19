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
