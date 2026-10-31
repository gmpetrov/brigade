<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Preview Brigade in a thread

To run Brigade for someone to try (a Brigade preview), or locally without Docker:

```bash
scripts/preview/setup.sh   # once, and again after pulling: Node 24, dependencies, builds, apps/api/.env, database, dev accounts
scripts/preview/start.sh   # PostgreSQL, the API and the dashboard at one address, port 3000
```

In a thread, start it with `start_preview({ repository: "gmpetrov/brigade" })`, nothing else: `.brigade/settings.toml` runs `scripts/preview/setup.sh`, then `scripts/preview/start.sh` on port 3000. The API answers at `/api` on the same address, so the preview needs one port and its session cookie works in the thread's preview pane. The preview opens on `/app`, never the landing page (to work on the landing, start it with `PREVIEW_LANDING=1` and `PREVIEW_SIGN_IN=`); a page opened without a working session is signed in as Ada (`proxy.mjs`, also after a session expired or the database was reset; after signing out, the sign-in page stays for the rest of the browser session; `PREVIEW_SIGN_IN=other@example.com` picks another account, `PREVIEW_SIGN_IN=` turns it off). To switch, sign out and sign in with the password `correct-horse-battery` as:

- `ada@example.com` (owner), `bob@example.com` (admin) or `carol@example.com` (member): straight into the sample Acme workspace, with teammates, projects, threads in each state, tasks in each column, open tickets, library files and memory, connections, credentials, schedules and a pull request (`apps/api/prisma/seed-workspace.ts`). Nothing in it reaches an outside service: its secrets are placeholders, and no runner answers, so a new message to a teammate does not run.
- `dana@example.com`: no organization yet, to try onboarding.

The seed runs with each `setup.sh` and adds the sample only when the Acme organization is missing; to start over, delete `.preview/` (embedded PostgreSQL) or run `docker compose down -v` (Docker), then `setup.sh` again.

`setup.sh` runs on each start of the preview, so it skips what is done already: pnpm's quick install check while `pnpm-lock.yaml` and what pnpm installed are as its last run left them (that check alone misses a lockfile-only update), the Prisma Client while its schema and output are as its last run left them (stamps in `.preview/stamps`), migrations the database has, and the seed when the dev accounts and their organization exist. In a preview on a cloud computer, a start with nothing new spent 24 seconds in setup, and now 4 to 5.

PostgreSQL comes from `docker-compose.yml` when Docker works, else from the `embedded-postgres` package (no Docker or root needed), with its data in `.preview/`; delete that folder to start over. Once the embedded one holds the data, it stays the one used even when Docker works later (deleting `.preview/` goes back to Docker), and Docker is not asked again: on a cloud computer, asking took 13 seconds of each start. A preview takes the embedded one too, unless the thread's Docker holds the database already: it is cached for every checkout on the computer, where each thread's Docker downloads PostgreSQL's image into its own (646 MB, 13 seconds). Downloads (Node, PostgreSQL) are cached in `~/.cache/brigade-preview`. If the dashboard goes blank, Next crashed: `start.sh` starts it again, and the page reloads by itself.

# Adding a built-in App

An account row shows only the account itself (the Gmail address, the Linear workspace, the Mixpanel organization), never just the App's name. Before writing the code that names an account (`mcp.account` for an MCP App), call that tool or URL once with a real account and read its actual reply; write the parser for that reply and keep it as the test's fixture, rather than guessing its shape from the docs. Then, in a Preview, connect a real account and check that its row shows the name before opening the pull request. A real account may be live: call only read tools while testing.

# Text too long for its space

Cut text fades out at its end; it never ends in an ellipsis (…). Use Tailwind's `truncate` (one line) or `line-clamp-*` (several lines): `apps/web/app/globals.css` makes them fade, only while the text overflows, so nothing else is needed. Do not write `text-overflow: ellipsis` or add "…" to text cut to fit. The fade covers the box's background and border too, so on a bordered or tinted box, put `truncate` on a span inside it. "…" on a word that says something is in progress ("Loading…") is not a cut and stays.
