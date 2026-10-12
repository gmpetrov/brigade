# Contributing to Brigade

## Setup

Requires Node.js 22+ (see `.nvmrc`), pnpm and Docker (for the local PostgreSQL).

```bash
pnpm install
docker compose up -d                       # PostgreSQL on localhost:5433
cp apps/api/.env.example apps/api/.env     # then set BETTER_AUTH_SECRET
pnpm --filter @brigade/api db:migrate      # apply migrations
pnpm dev                                   # api :3001, web :3000, collab :8787, package watchers
```

Without Docker: `scripts/preview/setup.sh`, then `scripts/preview/start.sh` (see [AGENTS.md](AGENTS.md)).
The [README](README.md) covers the layout, the runner and the theme.

Before you push:

```bash
pnpm build                # builds the shared packages typecheck depends on
pnpm typecheck
pnpm format:check         # or `pnpm format` to fix
```

## Branch naming

Branch from `main` and keep one change per branch.

- People: `<your-name>/<short-topic>`, e.g. `ada/runner-reconnect`.
- AI teammates: `brigade/<teammate>-<thread>` (assigned by Brigade; only `brigade/` branches can be pushed from a thread).
- Dependabot opens its own `dependabot/...` branches.

Changes reach `main` through a pull request; teammates cannot push to it.

## Opening a pull request

1. Push your branch: `git push -u origin HEAD`.
2. Open a PR against `main`. Title it like the commit log: the area, a colon, then what changes
   (`Tasks: assigning starts the work`).
3. In the description, say what changed and why, how you tested it (build, typecheck, a preview, a real account), and
   what you could not test.
4. Keep the PR focused; follow-up fixes go on the same branch while it is open.
5. A member reviews and merges it on GitHub.
