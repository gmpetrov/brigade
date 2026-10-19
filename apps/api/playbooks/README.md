# Playbooks shipped with the API

Each folder is a playbook template: its `playbook.yaml` (`PlaybookManifest` in
`@brigade/contracts`), its recipe as skills in `skills/<name>/SKILL.md`, and examples in
`samples/` for dry runs. Its id is `brigade/<folder>`.

`scripts/playbooks.mjs` turns the folders into `src/generated/playbooks.ts` (the API runs on Workers,
which have no files); `build`, `typecheck`, `dev` and `test` run it. `src/playbooks.ts` checks each
manifest when the API loads it, and `test/playbooks.test.ts` checks every template here.
