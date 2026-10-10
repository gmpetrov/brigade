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

| Step                            | Status                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Spike                        | Passed on macOS and on a boat VM (non-root user, subscription signed in through the dashboard, no API key, pause/resume).                                                                                                                                                                              |
| 2. Skeleton                     | Done.                                                                                                                                                                                                                                                                                                  |
| 3. Runner on a member's machine | Done. One-command install: `curl -fsSL <api>/runner/install.sh \| sh`.                                                                                                                                                                                                                                 |
| 4. Cloud computer               | Done: created with the workspace (or from Computers), runner as a systemd service, stops after the idle period, resumes on the next message or takeover, a Linux user per teammate, takeover with desktop, terminal and hand back.                                                                     |
| 5. Accounts                     | Mostly done: sign-in from the dashboard, several accounts per provider, default and per-thread choice, usage display, automatic switching with a handoff, Codex. Switching is untested against a real exhausted account.                                                                               |
| 6. Vault and first connector    | Done. Tested on a real Gmail mailbox: labels, search, read, a draft after approval, a send after approval.                                                                                                                                                                                             |
| 7. Control                      | Done. Caps (threads started, connector writes), every ticket path, the timeline and run log, triggers' signatures. Tested on real accounts: Gmail, Google Calendar (list, free/busy, create, get, delete), Stripe test mode (search, charges, customer update).                                        |
| 8. Browser                      | Done on the workspace computer: a Chrome per teammate with its own profile, driven through Playwright's MCP server, each thread in its own tabs (kept across turns), opened on the desktop from the dashboard for sign-in. Harness questions are tickets. Codex threads with the browser are untested. |
| 9. Memory and library           | Done on a member's machine: library in the bucket (a local folder until R2 is configured), mirrored to computers, memory through the harness's own instruction file, memory taken when a thread goes quiet, one full-text search. Not yet run on a cloud computer.                                     |
| 10–11                           | Not started.                                                                                                                                                                                                                                                                                           |

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
- **Permission mode.** `allow-all` on every computer: Brigade does not ask a person before an action unless the
  teammate opens a ticket (see "Tickets from teammates"), or its policy for connector writes says `ask`.
- **Thread directory** on a member's machine: `~/.brigade/teammates/<teammate>/threads/<thread>/`. Repositories are
  checked out inside it (see "Code from GitHub"). Idle harness sessions are stopped after 5 minutes and resumed from saved state.
- **Attachments.** A file given to a thread, uploaded in the dashboard (picked, dropped or pasted) or taken from a
  connection (an email's attachments, fetched once per file even when several triggers match), is an `Attachment`:
  bytes in the bucket, up to 25 MB, its type checked against its bytes. With R2 the browser uploads straight to the
  bucket: the API signs a PUT URL for 10 minutes that takes exactly the declared size and type (the bucket's CORS
  rule must allow the dashboard's origins, method `PUT`, header `content-type`), then reads the file back to check
  it. Without R2 uploads go through the API. Unfinished uploads go after an hour, unsent ones after a day. `ThreadAttachment` puts it in a thread at
  `attachments/<name>` (`-2` on a clash). The thread's spec lists all of them; before each turn the runner copies the
  ones a teammate's folder lacks, once (its edits stay), never executable, and the prompt says where they are.
  Programs and installers are not taken from outside, and small inline images (signatures) are left out; a file not
  kept is still named to the teammate, with why. Connector calls can bring files in (`gmail_read_attachment`) and send
  them (`gmail_send`'s `attachments`: paths the runner uploads first). Runners need protocol 7.
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
  `allow`). `ask` opens an approval ticket and the call waits; the thread shows it as an approval, answered from the
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
- **Triggers** (`apps/api/src/triggers.ts`, `routes/triggers.ts`). Each connector declares a catalog of events
  that can start a thread (Gmail: email received; Stripe: payment received or failed, new or canceled
  subscription, dispute, refund; GitHub: issue, pull request, review request, comment, push; Calendar: event
  created, changed, invitation), with options such as a Gmail search or a repository. A custom app connection has
  one: any event posted to the trigger's URL (`POST /hooks/<random token>`, HMAC `X-Brigade-Signature` or the URL
  alone). Each match starts one thread on the workspace computer, on the accounts of the admin who created the
  trigger: a short summary, then the raw event. Retries with the same event id start no second thread. Its
  writes follow the teammate's grants, policy and caps like any thread's: an event can ask for anything, so grant
  a triggered teammate only what it needs, or set it to `ask`. When a thread cannot start, the
  trigger's creator gets a ticket and the event is offered again (Stripe retries; Gmail and Calendar keep their
  cursor).
- **Schedules** (`apps/api/src/schedules.ts`, `routes/schedules.ts`, design in `docs/automations.md`). A teammate
  prompted with the same instructions on a cron schedule (five fields plus an IANA timezone, runs at least 5 minutes
  apart), each firing in a fresh thread on the accounts of the member who owns it. A minute tick moves `nextRunAt`
  with a conditional update, which is the claim: a firing starts once, and missed firings collapse into one. A firing
  is skipped while the previous run is still going; one that cannot start opens a ticket for the owner. Only the owner
  edits a schedule; admins may pause, run or delete it. Teammates create, list and change schedules with their tools,
  only from a member's thread (never a trigger's or a schedule's), owned by that thread's starter.
- **Subscriptions** (`apps/api/src/subscriptions/`). Brigade subscribes the vendor itself, synced whenever a
  connection's triggers change: a Stripe webhook endpoint per connection listing the events needed (its signing
  secret goes to the vault; a restricted key needs Webhook Endpoints write access); the GitHub App's one webhook;
  a Gmail `users.watch` through Pub/Sub (`GMAIL_PUBSUB_*`, renewed before its seven days run out), or, without
  Pub/Sub, a check every minute; a Calendar push channel per watched calendar, renewed before it expires. Vendor
  pushes arrive at `/events/stripe/:id`, `/events/gmail` and `/events/google-calendar`, each verified. Gmail and
  Calendar pushes only say something changed: the mailbox's history and the calendar's sync token say what.
  Pushes need a public HTTPS `API_URL`. Brigade's own writes (a teammate's sent mail, calendar changes, GitHub
  actions by the app) start nothing.
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
- **Tickets from teammates.** Both harnesses get Brigade's `open_ticket` tool (no `execute`, so the turn pauses on
  it). A ticket holds 1–6 asks, each with a type: `approval` (sign-off on a draft or plan: Approve, or Request
  changes with a note, sent back to the asking teammate or another one, who gets the draft and the note as a
  message), `decision` (one button per option, or Approve / Decline), `access` (a connection or credential: open
  Connections or the Vault, then Mark granted), `action` (something only a person can do, with an optional
  checklist: I've done this) and `input` (Provide details; a secret one takes a credential from the vault). It
  opens a `request` ticket (`ticket.opened`); the answer, sent once every ask has one, goes back as the tool's
  result (`ticket.answered`). From the Tickets page it can only be declined. Invalid input is returned to the
  teammate as a tool error instead of pausing the turn.
- **Credentials** (`apps/api/src/credentials.ts`, `apps/runner/src/credentials.ts`). Members keep website logins,
  databases, API keys and other secrets in the vault from the Vault page; only non-secret details (URL, username,
  host) are ever returned. A teammate gets `list_credentials`, `use_credential` and, with a browser,
  `fill_credential`. The API releases a secret to the thread's runner once a member mentioned the credential in
  that thread (`@[Name](credential:id)` in a message or an answer; a trigger's event has no member, so it cannot)
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
- **Updating the root helper.** See "Root setup on cloud computers" below: the API reapplies it when it changes.
- **Threads with several teammates.** Mentioning a teammate (`@[Name](teammate:id)`) in a member's message brings it
  into the thread (`ThreadTeammate`) and has it answer; several mentions answer one after another, in order. A
  message with no mention goes to the teammate asked last. The thread keeps its starting teammate (`Session.teammateId`),
  computer and the starter's accounts; each teammate runs its own harness session, in its own directory and Linux user,
  on an account of its own harness. Before each turn the runner tells the teammate what was said since its last one
  (members' messages and the other teammates' replies, kept in `~/.brigade/state/<thread>.team.json`); a thread with
  one teammate reads exactly as before. Harness events carry `teammateId`, and each turn starts with `turn.started`
  (teammate and account), so tickets, connector grants, caps, usage and the timeline are each teammate's own. A
  trigger's event summons nobody. On a runner below protocol 2 the API sends turns only to the starting teammate.
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
- **Library** (`apps/api/src/library.ts`). Files go in the one bucket under `<organization>/<workspace>/library/<document id>`
  (Cloudflare R2 through its S3 API; without `R2_*`, development uses `apps/api/.bucket`). `Document` keeps path,
  type, size, SHA-256 and the text (UTF-8 files and PDFs; other files are kept but not searchable). Any member
  uploads, edits, renames and deletes from the Library page; every change is audited. A file is served inline only
  for types that cannot run script (`Content-Security-Policy: sandbox` always); anything else downloads.
- **Library on computers** (`apps/runner/src/library.ts`). The runner mirrors the library read-only, at
  `/var/lib/brigade/library` on the workspace computer (written by the runner, read by teammate users) and
  `~/.brigade/library` on a member's machine. It fetches a manifest from `GET /runner/library` (runner token) on
  every connect, when the API sends `library.changed`, and every 15 minutes. A teammate's grant on the library is
  `read` (default) or `read_write`; with write it gets `save_to_library`, which sends a file it wrote through the
  API. There is no "no access": the workspace is one trust zone and the mirror is shared.
- **Memory** is three kinds of Markdown `Document` with no bucket object: workspace (`workspace.md`), teammate
  (`teammates/<id>.md`) and thread summaries (`threads/<id>.md`). Memory loads through the harness's own file: the
  runner writes `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex) into the thread's directory each time a harness
  session starts, with the workspace's and the teammate's memory and where the library is. A file of that name
  Brigade did not write is left alone.
- **When a thread ends** is when it goes quiet: 5 minutes after its last turn (`BRIGADE_QUIET_MS` overrides, for
  tests), the runner runs the thread's harness once more, outside the thread, with no tools, on the same account,
  in an empty directory. It reads what was said since the last time and answers with a summary and lines to add to
  or remove from each memory file. The API applies those lines (`applyMemoryEdit`) one file at a time, so threads
  ending together never overwrite each other or people's edits. A private thread (set by its starter) leaves
  workspace memory alone, and its summary is searchable only by the starter.
- **Search** is PostgreSQL full text: a generated `tsvector` (path weighted over text; `english` stemming for text,
  `simple` for paths) with a GIN index, queried with `websearch_to_tsquery`. Teammates get `search_workspace`
  (answered like a connector call); a teammate finds its own memory, never another teammate's.
- **Code from GitHub** (`apps/api/src/git.ts`, `apps/api/src/routes/git.ts`, `apps/runner/src/repos.ts`). GitHub is
  the source of truth; a computer's disk is a cache. Git reaches GitHub only through the API, which proxies git's
  smart HTTP protocol at `/git/<owner>/<name>.git` and adds the installation token there, so no GitHub credential
  reaches a computer (hard constraint 4). A teammate granted a GitHub connection gets `git` in its thread spec: the
  proxy URL and a token signed by the API (HKDF from `BETTER_AUTH_SECRET`, 7 days) naming the thread, teammate and
  computer. Every request is checked again: the thread on that computer, the teammate in it, a grant whose
  installation reaches the repository (public repositories outside any installation are readable anonymously, so
  dependencies keep working). Pushes need a `read_write` grant and a policy other than `deny`, count toward the write
  cap, and may only update branches under `brigade/`; anything else is refused the way GitHub refuses a protected
  branch (`! [remote rejected]`). Propose changes with `github_create_pull_request`, which asks as usual. Each clone or
  fetch (`git_fetch`) and push (`git_push`) is a `ConnectionCall`. The runner passes git its settings as
  `GIT_CONFIG_*` environment, never a file: the token as an `extraHeader` for the proxy URL only, and on the workspace
  computer `github.com` URLs rewritten to the proxy and the teammate as commit author. Each teammate keeps a bare
  cache per repository (`~/.repos/<owner>/<name>.git`, never pruned; `~/.brigade/repos` on a member's machine);
  `checkout_repository` clones into the thread's directory with `--reference` to it, on
  `brigade/<teammate>-<thread>`. When a thread goes quiet the runner backs up unpushed commits and changes to
  tracked files (`git stash create`, so the teammate's branch and files are untouched) to
  `brigade/wip/<thread>/<teammate>/<folder>` (`git_backup`, not counted toward caps). Untracked files are not backed
  up, since they may hold secrets. When GitHub will not take the backup (a read-only grant, say), the runner sends a
  `git bundle` of what GitHub lacks to `PUT /runner/backups/...` (runner token, threads on its computer only), kept in
  the bucket at `<organization>/<workspace>/repos/<owner>/<name>/<thread>/<teammate>/<folder>.bundle`. A new checkout
  in the same thread restores the backup (GitHub's first, then the bucket's) unless the pushed branch moved past it.
  Cloned and fetched through a real installation; pushes to GitHub, and all of it on a cloud computer, are untested.
- **Repositories need only a GitHub connection.** There is no list of projects to keep: a message mentions any
  repository the workspace's connections reach (`@[owner/name](repository:owner/name)`, offered from
  `GET /api/repositories`; older messages' `project:` mentions still render). How to set a repository up and work
  on it is the repository's own business: after `checkout_repository` the teammate reads its `AGENTS.md`,
  `CLAUDE.md` or README and installs what it needs. Brigade runs no setup script of its own.
- **Push webhook** (`apps/api/src/routes/github-webhook.ts`). With `GITHUB_APP_WEBHOOK_SECRET` set and the app's
  webhook at `{API_URL}/github/webhook` (event "Push"), a push sends `repos.changed` to every online computer
  (protocol 5) of the workspaces using that installation, found by the connection's settings URL ending in
  `/installations/<id>`. It carries a fetch-only token per granted teammate, valid ten minutes and tied to no thread
  (not in any thread's call log); the runner fetches only caches it already has, and the message never wakes a stopped
  computer or postpones its idle stop. Installation events reset the repository lists and the connections' status.
- **Disk sweep** (`sweep` in `apps/runner/src/repos.ts`, every 6 hours). Threads are never archived, so the runner
  removes a checkout when its thread is not in use there, its git files are 14 days old, and it holds nothing GitHub
  lacks: no changes or untracked files (`git --no-optional-locks status`, so looking does not refresh the index), no
  stash, no commit outside the remote branches. Then caches no remaining checkout borrows from, untouched for 30 days.
  A thread that comes back checks its repository out again and continues its branch or backup.
- **Root setup on cloud computers.** The helper and the library folder are one versioned setup script
  (`setupScript` in `cloud-bootstrap.ts`). A cloud runner reports the setup it has on connect; the API reapplies the
  current one through the provider when they differ. This replaces reinstalling the helper by hand.
- **Files in a thread.** A file path in a teammate's reply (inline code such as `faq/support.md` or `src/a.ts:42`, or a
  relative Markdown link) opens in a panel beside the thread, in the desktop panel's place (a bottom sheet on narrow
  screens). `GET /api/threads/:id/file` serves a library path from the library, so it opens while the computer is
  stopped; anything else is read by the runner (`thread.file.read`) from the replying teammate's working folder for
  that thread (then the others'), or the library mirror, after resolving links, as the teammate's user, text only, up
  to 1 MB. It never wakes a stopped computer.
- **Pull requests** (`apps/api/src/pull-requests.ts`, `routes/pulls.ts`, the Pull requests page). GitHub keeps the
  code and the pull request; `PullRequest` keeps who wrote it (from the thread's `github_create_pull_request`, or,
  for older ones, the call log by branch), who reviews it and where its review loop stands. The list reads, live
  from GitHub, every repository where a teammate opened a pull request; a person's pull request elsewhere is not
  listed. A pull request's page shows its description, checks, reviews and diff. Until the workspace has a working
  GitHub connection, the page shows how to connect one. Any member asks a teammate to review a pull request; only
  owners and admins merge, or arm a review to merge once approved. Teammates never merge.
- **Review loop.** The review runs in the thread that opened the pull request, so the author keeps its context (a
  pull request from outside Brigade gets a thread of its own, without an author to fix it). The reviewer is brought
  into the thread and asked to call `github_review_pull_request` once: approve or request changes, with line
  comments. When its turn ends, the API reads that verdict: changes go to the author as its next message; when the
  author's turn ends, the reviewer is asked again with the commits since its review. After 3 rounds without an
  approval, or when a teammate cannot be reached, the loop stops and opens a ticket. An approval armed to merge is
  checked when it comes in and every minute: pending checks wait, failed checks and conflicts go back to the author,
  a branch behind its base is brought up to date (a merge of the base into the approved commit counts as approved),
  and a branch protection rule GitHub enforces opens a ticket. Merges are squash, audited as `pull_request.merged`.
  Every teammate acts as the GitHub App, and GitHub refuses a verdict on the app's own pull request, so there a
  review is a comment that starts with the verdict, and the verdict itself lives in Brigade. A repository requiring
  an approving review needs a person to approve on GitHub, or the app allowed to bypass the rule.
