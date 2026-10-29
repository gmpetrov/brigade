# Development

The [README](../README.md#run-it-locally) has the short version. This page has the details: running threads on your
machine, Brigade.app and computer use on macOS, and the dashboard's theme.

## Set up

Requires Node.js 24 (`.nvmrc`), pnpm and Docker (for the local PostgreSQL).

```bash
pnpm install
docker compose up -d                       # PostgreSQL on localhost:5433
cp apps/api/.env.example apps/api/.env     # then set BETTER_AUTH_SECRET
pnpm --filter @brigade/api db:migrate      # apply migrations
cp apps/collab/.dev.vars.example apps/collab/.dev.vars   # optional: COLLAB_SECRET, the same as in apps/api/.env
pnpm dev                                   # api :3001, web :3000, collab :8787, package watchers
```

Open http://localhost:3000, create an account, an organization and a workspace, then a teammate.

Without Docker, or for a preview in a Brigade thread: `scripts/preview/setup.sh`, then `scripts/preview/start.sh` (see [AGENTS.md](../AGENTS.md)).

## Run threads on your machine

In the dashboard, open **Computers → Get a link code**, then in a shell where `claude` is signed in:

```bash
pnpm --filter @brigade/runner build
node apps/runner/dist/index.js link <CODE> --api http://localhost:3001
node apps/runner/dist/index.js start
```

The runner keeps its token, event outbox and harness state in `~/.brigade` (override with `BRIGADE_HOME`).
It strips `ANTHROPIC_*` and other API-key variables at startup, so Claude Code runs on your subscription login.
Only one runner runs per home: `start` claims `runner.pid` and exits with code 3 while another holds it.

## Brigade.app and computer use (macOS)

Members link a Mac with **Brigade.app** (`apps/desktop`) instead of the terminal: **Computers → Link this Mac →
Open in Brigade** opens a `brigade://link?code=…&api=…` link, the app asks before connecting, runs the API's
`install.sh` (Node.js and the runner, as the command does), links the runner and keeps `brigade-runner start`
running from the menu bar. The runner still updates itself from the API's bundle; the app updates itself from
GitHub Releases (`apps/desktop/release`). Logs: `~/.brigade/logs/runner.log`.

Inside it, **Brigade Computer Use.app** (`apps/computer-use-macos`) gives teammates `computer_screenshot`,
`computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`,
`computer_apps`, `computer_open_app` and `computer_ui_tree` on the member's Mac. The runner starts it with `open`,
so macOS gives Screen Recording and Accessibility to it, not to Brigade.app or a terminal, and talks to it over a
token-checked socket in `~/.brigade/computer-use`. While a teammate acts, a pill shows its name with a Stop button
(no Esc shortcut); Stop ends computer use for that turn.

```bash
pnpm --filter @brigade/computer-use-macos install:app   # helper only, into ~/Applications (runner finds it there)
pnpm --filter @brigade/desktop build:app                 # Brigade.app and its .dmg, with the helper inside
```

Both sign with the first "Developer ID Application" identity in the keychain (or `BRIGADE_SIGN_IDENTITY`), else ad
hoc, in which case macOS asks for the helper's permissions again after each rebuild. To try Brigade.app without
touching your real runner, run its binary with `BRIGADE_HOME` set to another folder.

## Public docs

The user docs at [www.brigade.lol/docs](https://www.brigade.lol/docs) are a Mintlify site in `apps/docs`
(`docs.json`, one `.mdx` file per page). Mintlify builds it from `main` and hosts it at `brigade.mintlify.site`;
the dashboard's Worker serves it under `/docs` with the rewrites in `apps/web/next.config.ts`. The pages describe
what the code does: change them in the same pull request as a change they describe.

```bash
pnpm docs                                    # http://localhost:3333, reloads as you edit
pnpm --filter @brigade/docs check            # Mintlify's validation and broken links
```

## Theme

The web app uses [shadcn/ui](https://ui.shadcn.com) on Tailwind v4. Its palette, fonts, radius, spacing and shadows
come from one [tweakcn](https://tweakcn.com) theme (Violet Bloom by default). To switch, pass a theme name or any
tweakcn URL:

```bash
pnpm --filter @brigade/web theme violet-bloom
```

```bash
pnpm --filter @brigade/web theme "https://tweakcn.com/editor/theme?theme=amethyst-haze"
```

This rewrites `apps/web/app/theme.css` and `apps/web/app/theme-fonts.ts` only. `app/globals.css` maps the theme into
Tailwind and adds Brigade's status colors (`success`, `warning`, `destructive-text`); components in
`apps/web/components/ui` use theme tokens only, so nothing else changes. Light, dark or system is the user's choice
from the sidebar.

## Spike (build step 1)

`pnpm --filter @brigade/runner spike [workdir]` runs Claude Code through `HarnessAgent` with the bridge on this
machine, pauses a turn mid-stream, continues it, detaches and resumes.
