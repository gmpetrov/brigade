# Playbooks shipped with the API

Each folder is a playbook template ("loop" in code): its `loop.yaml` (`LoopManifest` in
`@brigade/contracts`), its recipe as skills in `skills/<name>/SKILL.md`, and examples in
`samples/` for dry runs. Its id is `brigade/<folder>`.

`scripts/loops.mjs` turns the folders into `src/generated/loops.ts` (the API runs on Workers,
which have no files); `build`, `typecheck`, `dev` and `test` run it. `src/loops.ts` checks each
manifest when the API loads it, and `test/loops.test.ts` checks every template here.
