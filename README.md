# Brigade

The control plane for a business or project run with AI teammates. The product spec lives outside this repo
("Brigade product spec", Oct 9, 2026); this README tracks what is built and the choices made where the spec is silent.

## Layout

pnpm workspaces + Turborepo.

| Path                 | Package              | Runs                                                                                                                                |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | `@brigade/contracts` | Zod schemas: `AgentEvent`, API payloads, runner and browser socket messages. Imported by all others.                                |
| `packages/providers` | `@brigade/providers` | `ComputerProvider` interface (boat implementation arrives in build step 4). Used only by `api`.                                     |
| `apps/api`           | `@brigade/api`       | Hono on Node.js: auth, workspaces, teammates, threads, runner linking, the WebSocket hub. The only package that touches PostgreSQL. |
| `apps/runner`        | `@brigade/runner`    | `brigade-runner`: links a computer to a workspace and runs its threads through the AI SDK harness layer.                            |
| `apps/web`           | `@brigade/web`       | Next.js dashboard and landing page.                                                                                                 |

## Develop

Requires Node.js 22+, pnpm and Docker (for the local PostgreSQL).

```bash
pnpm install
docker compose up -d                       # PostgreSQL on localhost:5433
cp apps/api/.env.example apps/api/.env     # then set BETTER_AUTH_SECRET
pnpm --filter @brigade/api db:migrate      # apply migrations
pnpm dev                                   # api :3001, web :3000, package watchers
```

Open http://localhost:3000, create an account, an organization and a workspace, then a teammate.

### Run threads on your machine

In the dashboard, open **Computers → Get a link code**, then in a shell where `claude` is signed in:

```bash
pnpm --filter @brigade/runner build
node apps/runner/dist/index.js link <CODE> --api http://localhost:3001
node apps/runner/dist/index.js start
```

The runner keeps its token, event outbox and harness state in `~/.brigade` (override with `BRIGADE_HOME`).
It strips `ANTHROPIC_*` and other API-key variables at startup, so Claude Code runs on your subscription login.

### Theme

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

### Spike (build step 1)

`pnpm --filter @brigade/runner spike [workdir]` runs Claude Code through `HarnessAgent` with the bridge on this
machine, pauses a turn mid-stream, continues it, detaches and resumes.

## Build status

| Step                            | Status                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Spike                        | Passed on macOS and on a boat VM (non-root user, subscription signed in through the dashboard, no API key, pause/resume).                                                                                                                                                                                   |
| 2. Skeleton                     | Done.                                                                                                                                                                                                                                                                                                       |
| 3. Runner on a member's machine | Done. One-command install: `curl -fsSL <api>/runner/install.sh \| sh`.                                                                                                                                                                                                                                      |
| 4. Cloud computer               | Done: created with the workspace (or from Computers), runner as a systemd service, stops after the idle period, resumes on the next message or takeover, a Linux user per teammate, takeover with desktop, terminal and hand back.                                                                          |
| 5. Accounts                     | Mostly done: sign-in from the dashboard, several accounts per provider, default and per-thread choice, usage display, automatic switching with a handoff, Codex. Switching is untested against a real exhausted account.                                                                                    |
| 6. Vault and first connector    | Done. Tested on a real Gmail mailbox: labels, search, read, a draft after approval, a send after approval.                                                                                                                                                                                                  |
| 7. Control                      | Done. Caps (threads started, connector writes), every ticket path, the timeline and run log, Stripe and HMAC webhook signatures, webhook writes always asking. Tested on real accounts: Gmail, Google Calendar (list, free/busy, create, get, delete), Stripe test mode (search, charges, customer update). |
| 8. Browser                      | Done on the workspace computer: a Chrome per teammate with its own profile, driven through Playwright's MCP server, each thread in its own tabs (kept across turns), opened on the desktop from the dashboard for sign-in. Harness questions are tickets. Codex threads with the browser are untested.      |
| 9–11                            | Not started.                                                                                                                                                                                                                                                                                                |

## Decisions where the spec is silent

- **Name clashes with better-auth.** better-auth's `session` and `account` tables are `AuthSession` and `AuthAccount`;
  the spec's `Session` (a thread) and `Account` (a harness login) keep their names.
- **Scope lives in the auth session.** `AuthSession.activeOrganizationId` / `activeWorkspaceId` are the only source of
  scope. `scoped()` in `apps/api/src/db.ts` adds the organization and workspace to every query and create. Switching
  workspace goes through `POST /api/workspaces/switch`, which checks membership. A fresh sign-in defaults to the first
  organization and workspace.
- **Append-only logs** are enforced in PostgreSQL by triggers on `AuditEntry`, `SessionEvent` and `ConnectionCall`.
  Rows go only when their workspace is deleted (cascade). `AuditEntry.workspaceId` is null for organization-level actions.
- **Runner link codes** reuse better-auth's `Verification` table (hashed code, 10 minutes, one use). Runner tokens are
  stored as SHA-256 hashes. Linking also records an `Account` ("Claude on <machine>") for the member; its status turns
  `ready` after a successful turn and `needs_sign_in` on an auth error. The credential is never seen.
- **Sequence numbers are assigned by the runner**, including for the user's prompt (`message.user`, an addition to the
  spec's `AgentEvent` list) and `approval.resolved` (with the member who answered). The API stores them idempotently by
  `(sessionId, seq)` and acks the highest contiguous one.
- **Thread status is derived from events** (`message.user` → running, `approval.requested` → waiting,
  `turn.completed` → idle, `error` → failed), so it survives disconnects and replays.
- **Event mapping.** Reasoning becomes `raw` with `source: "reasoning"`. Claude Code's `rate_limit_event` becomes
  `usage.updated` with 5-hour and 7-day utilization and reset times. Low-level `stream_event` echoes are dropped.
- **Permission mode.** Member machine: `allow-reads` (ask before writes and commands). Cloud: `allow-all`.
- **Thread directory** on a member's machine: `~/.brigade/teammates/<teammate>/threads/<thread>/` until projects and
  worktrees arrive in step 11. Idle harness sessions are stopped after 5 minutes and resumed from saved state.
- **Approvals are answered inline** in the thread; ticket rows and the ticket queue come with steps 6–7.
- **Sign-in is email and password** for now. Invitations by email come with step 10.
- **The runner ships its own pinned pnpm** (10.x), because the Claude Code adapter installs its bridge with
  `pnpm install --frozen-lockfile` and older global pnpm versions reject its lockfile.
- **Sign-in never needs access to the computer** (changes the spec's "sign in through takeover"). The runner runs the
  vendor's own login command into a config directory per account (`~/.brigade/accounts/<id>`, via
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Codex uses its device-code flow: the dashboard shows the vendor URL and code,
  and nothing comes back through Brigade. Claude has no device flow: the dashboard opens Claude's page, Claude shows a
  one-time code, and the member pastes it into the dashboard. The API relays that code to the computer without storing
  or logging it. It is bound to a PKCE verifier that never leaves the computer, so it is useless on its own.
- **The runner never reads a login.** The adapters get an empty auth environment (`auth: {}`), so they forward no
  credential and the vendor CLI uses its own login from the account's config directory.
- **Machine logins.** On a member's own machine the runner reports, on connect, which harnesses are signed in there
  (from `claude auth status` / `codex login status`, never a credential). The API keeps an account per login.
- **Stacking and switching.** A thread runs on the starter's chosen or default account on its computer. When the
  harness reports the account is out of usage, the runner continues on the next usable account of the same member,
  in a new harness session in the same directory, whose first message is a summary of the thread so far. With none
  left the thread pauses (`account.switched` with no target) and a `usage_limit` ticket is opened.
- **Codex** threads run with built-in tools allowed: the adapter cannot ask before them (spec known limit).
- **Cloud computer install.** The API creates the VM through `ComputerProvider` (no account secrets reach it), then
  runs a generic Ubuntu bootstrap (`apps/api/src/cloud-bootstrap.ts`): a `brigade` user, Node.js and the runner in
  `/opt/brigade` from the API's own bundle (`pnpm --filter @brigade/runner bundle`), a one-time link code, and a
  systemd service. The runner's token stays in `/home/brigade` (mode 700).
- **Teammate Linux users.** On the workspace computer each teammate runs as `bt-<id>` with a private home; its threads
  live in `~/threads/<thread>`. The runner may only call a small root helper (`/usr/local/sbin/brigade-teammate`) and
  run commands as teammate users. Account logins live in `/var/lib/brigade/accounts`, readable by teammate users only
  (one trust zone, per the spec). Each teammate gets a private config directory per account that links only the login
  file, so conversation history stays private; a login refreshed during a turn is moved back to the shared place
  without being read.
- **Takeover.** Take over (after the current turn, or now) stops the teammate; prompts are refused meanwhile. The
  desktop comes from the provider. The terminal runs as the teammate in the thread's directory, through `script`, and
  is relayed over the runner's existing socket. Each command run is logged as a `terminal.command` event under the
  member's name. Hand back sends the note and the files changed since takeover as the teammate's next message.
- **Idle stop.** Every minute the API stops cloud computers with no running thread and no activity for
  `IDLE_STOP_MINUTES` (default 30). Commands for a stopped computer start it and wait in memory (10 minutes) until its
  runner reconnects. boat trial accounts also impose a 2-hour auto-stop (`BOAT_AUTO_STOP_SECONDS`).
- **Vault.** AES-256-GCM, with each organization's key derived (HKDF) from `VAULT_KEY`; the workspace id is bound
  in as authenticated data, so a secret cannot be moved to another workspace. Decrypted only inside the API, per call.
- **Connector calls** (`apps/api/src/connector-calls.ts`). The runner passes granted operations to `HarnessAgent` as
  AI SDK tools; each `execute` sends `connector.call` over the runner's socket. The API checks the thread is on that
  runner's computer, the grant, read vs write, and the teammate's policy for writes (`allow`, `ask`, `deny`; default
  `ask`). `ask` opens an approval ticket and the call waits; the thread shows it as an approval, answered from the
  thread or the Tickets page by the thread's starter or an admin. Every call, refused ones included, is recorded in
  `ConnectionCall`. A call waiting for approval does not survive an API restart (its ticket is then marked expired
  when answered). Vendor errors are scrubbed of anything that looks like a key or token before they are logged or
  returned, since Stripe echoes a masked key.
- **Connections** are kept as `removed` when disconnected, so their call log survives; the credential is revoked at
  the provider (Google) and deleted from the vault. Gmail and Google Calendar connect through Google OAuth; Stripe
  takes a secret or restricted key pasted once into a dashboard form, straight into the vault.
- **Caps** (`apps/api/src/caps.ts`) are counted from the logs, per UTC day: threads created, working time (from a
  prompt or approval to the end of the turn or the next approval request), and write calls made per connection.
  Reaching a cap pauses the work and opens a `cap` ticket that only an admin answers. "Allow once" runs the held
  turn or connector call; "Deny" ends a never-started thread or drops the call. Raising the cap is a teammate edit.
- **Tickets.** Built-in tool approvals from the harness are tickets too (closed when the runner reports the answer),
  so the queue holds every approval. Expired logins open a `sign_in` ticket for the account's owner, closed by the
  next successful sign-in. A pause for usage closes when the thread is prompted again. One function,
  `resolveTicket` (`apps/api/src/decide.ts`), answers tickets for both the Tickets page and the thread view.
- **Status timeline and run log** (`apps/api/src/timeline.ts`) are computed on request from `SessionEvent`,
  `ConnectionCall`, `Ticket` and `AuditEntry`. A turn held by a cap has no events yet, so its ticket marks it blocked.
- **Inbound webhooks** (`apps/api/src/routes/webhooks.ts`) live at `POST /hooks/<random token>`. Verification is
  Stripe's `Stripe-Signature` (5-minute tolerance, secret pasted after adding the URL in Stripe), an HMAC Brigade
  generates (`X-Brigade-Signature: sha256=<hex>`, shown once), or the URL alone. Retries with the same event id
  start no second thread. The thread runs on the workspace computer, on the accounts of the admin who created the
  webhook; the payload is its first message, under one line naming the webhook and event. Every connector write
  in such a thread asks a person, whatever the teammate's policy. When a thread cannot start, the sender gets a
  503 with `Retry-After` and the webhook's creator gets a ticket.
- **Teammate browser** (`apps/runner/src/browsers.ts`). On the workspace computer each teammate has one Chrome,
  running as its Linux user with its profile in `~/.browser`, shown on the computer's desktop. The root helper
  starts it, lets that user draw on the display, and adds a firewall rule so only that user can reach its
  DevTools port (`20000 + uid`, localhost). The harness gets Playwright's MCP server (`@playwright/mcp`, through
  the adapters' native `mcpServers` setting), so Brigade writes no browser tool. On a member's own machine nothing
  is configured: the harness uses whatever browser access the member has set up.
- **One browser, a tab set per thread** (`apps/runner/src/browser-relay.ts`). Playwright's MCP server would adopt
  every open tab, so each thread reaches the browser through a small DevTools relay that shows it only the tabs it
  opened and their popups. The harness restarts MCP servers between turns, so a thread's tab ids are kept in
  `~/.browser-tabs/<thread>.json`; tabs of threads idle for a day are closed.
- **Sign-in through the dashboard.** "Open <teammate>'s browser" (teammate page, and the takeover panel) opens a
  window of that teammate's Chrome on the desktop, optionally at a URL, and shows the desktop. Whatever a person
  signs in to stays in that teammate's profile only.
- **Questions.** When the harness asks a person something, the thread waits and a `question` ticket opens; the
  answer goes back as the tool's result. Claude Code uses its built-in question tool. Codex's adapter has none, so
  Codex threads get Brigade's `ask_user` tool, which has no `execute`: `HarnessAgent` pauses the turn on it and the
  answer continues it, with option labels rather than ids. A question asking for a secret takes options, a
  credential picked from the vault (sent as its mention, never its value) or a decline. A site that signed the
  teammate out shows up this way, as the teammate asking a person to sign it in again.
- **Credentials** (`apps/api/src/credentials.ts`, `apps/runner/src/credentials.ts`). Members keep website logins,
  databases, API keys and other secrets in the vault from the Vault page; only non-secret details (URL, username,
  host) are ever returned. A teammate gets `list_credentials`, `use_credential` and, with a browser,
  `fill_credential`. The API releases a secret to the thread's runner once a member mentioned the credential in
  that thread (`@[Name](credential:id)` in a message or an answer; a webhook payload has no member, so it cannot)
  or a person approves an approval ticket; every release is audited and listed under the credential's uses. A
  website password is typed into the thread's own tab by `credential-fill`, running as the teammate's user, only
  when the page's host is the credential's host or a subdomain, then Enter is pressed: the model never sees it,
  though it could still read the field back from the page. Other kinds become a `0600` env file outside the
  working directory (`DATABASE_URL`, `PG*`, `API_KEY`, `SECRET`), removed when the thread parks; the model gets
  the path and variable names, and can read the file if it chooses.
- **Watching the desktop** (`apps/api/src/desktop-proxy.ts`). A thread on the workspace computer can show its
  desktop beside it, view only, without stopping the teammate or waking a stopped computer. The provider's desktop
  URL logs in with a cookie that browsers drop inside a third-party iframe, so the API logs in itself and relays the
  noVNC page and its socket under a random view id that lapses after an hour unused. The browser never sees the
  provider's URL. View only is noVNC's own setting, not a boundary: any member may take over anyway.
- **Updating the root helper.** New workspace computers get the helper from the bootstrap. A runner upgrade does
  not change root-owned files, so an existing computer needs the helper reinstalled when it changes.
- **Threads with several teammates.** Mentioning a teammate (`@[Name](teammate:id)`) in a member's message brings it
  into the thread (`ThreadTeammate`) and has it answer; several mentions answer one after another, in order. A
  message with no mention goes to the teammate asked last. The thread keeps its starting teammate (`Session.teammateId`),
  computer and the starter's accounts; each teammate runs its own harness session, in its own directory and Linux user,
  on an account of its own harness. Before each turn the runner tells the teammate what was said since its last one
  (members' messages and the other teammates' replies, kept in `~/.brigade/state/<thread>.team.json`); a thread with
  one teammate reads exactly as before. Harness events carry `teammateId`, and each turn starts with `turn.started`
  (teammate and account), so tickets, connector grants, caps, usage and the timeline are each teammate's own. A
  webhook's payload summons nobody. On a runner below protocol 2 the API sends turns only to the starting teammate.
- **Runner updates** (`apps/runner/src/updater.ts`). The API's runner bundle is the only version that counts: a
  runner reports the SHA-256 of the bundle it was installed from (the installer stamps it, after checking it against
  the API's `x-bundle-sha256` header), and the API names the one it serves in `welcome`, and in `update.available`
  when the file changes. A runner with another bundle waits until no turn is running or queued and no terminal or
  sign-in is open, disconnects, parks its threads (as on any stop) and runs the API's own installer into its install
  directory, then exits with code 75. The installer's wrapper (`bin/brigade-runner`) starts the new runner on that
  code; systemd restarts it anyway; a runner started by an older wrapper starts the new one itself, once. Rollbacks
  work the same way, since any different bundle counts. A failed install keeps the old runner (directories are
  swapped last) and is not retried for an hour. Runners started from source never update; `BRIGADE_AUTO_UPDATE=0`
  turns it off. Cloud runners from before self-update (protocol below 3) are reinstalled once per bundle through
  the provider while idle.
