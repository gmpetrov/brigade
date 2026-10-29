# Decisions where the spec is silent

The product spec lives outside this repository ("Brigade product spec", Oct 9, 2026). This page records the
choices made where it is silent. The code and the other pages in [docs/](.) are the truth about what ships.

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
  it. A member's video can be up to 500 MB, outside a message's 50 MB total: the API never holds it whole (its size
  from the bucket, its SHA-256 as it streams by), and the dashboard and the runner get it from a signed bucket URL
  the API redirects to; the runner writes it to its cache as it arrives. Without R2 uploads go through the API. Unfinished uploads go after an hour, unsent ones after a day. `ThreadAttachment` puts it in a thread at
  `attachments/<name>` (`-2` on a clash). The thread's spec lists all of them; before each turn the runner copies the
  ones a teammate's folder lacks, once (its edits stay), never executable, and the prompt says where they are.
  Programs and installers are not taken from outside, and small inline images (signatures) are left out; a file not
  kept is still named to the teammate, with why. Connector calls can bring files in (`gmail_read_attachment`) and send
  them (`gmail_send`'s `attachments`: paths the runner uploads first). Runners need protocol 7.
- **Approvals are answered inline** in the thread; ticket rows and the ticket queue come with steps 6–7.
- **The chief.** Every workspace has one teammate of kind `chief`, named `Chief` (people mention it as @Chief, or @chief); it
  can't be renamed or archived. Its role lives in the runner (`instructions.ts`), not in the database. It interviews a
  new workspace's owner and proposes a team with `propose_team`, shown as a card a person edits and creates
  (`POST /api/teammates/team`): those teammates run on the chief's agent, start with connector writes on `ask`, and
  get the connections they need that the workspace has. The chief answers what one reply settles; a teammate it
  @mentions joins the thread and answers next (only the chief can bring in teammates not yet in a thread, protocol
  18), and bigger work becomes a task. Onboarding names the project (organization and first workspace), then asks
  for an AI account: the dashboard stays closed until the member has one that has worked in that workspace.
- **Sign-in is Google or a code mailed to the address** (`src/sign-in-code.ts`, better-auth's emailOTP), which
  also signs up a new address: an account is only made by someone who reads its mail, and an invitation is only taken
  by a proven address. Passwords are off (`PASSWORD_SIGN_IN`), except locally and in previews for the dev accounts.
  Sign-in requests are rate-limited per visitor (`cf-connecting-ip`, counted in the `RateLimit` table), and with
  `TURNSTILE_SECRET_KEY` (API) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (dashboard) a code is mailed only after
  Cloudflare Turnstile's check.
- **The runner ships its own pinned pnpm** (10.x), because the Claude Code adapter installs its bridge with
  `pnpm install --frozen-lockfile` and older global pnpm versions reject its lockfile.
- **Sign-in never needs access to the computer** (changes the spec's "sign in through takeover"). The runner runs the
  vendor's own login command into a config directory per account (`~/.brigade/accounts/<id>`, via
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Codex uses its device-code flow: the dashboard shows the vendor URL and code,
  and nothing comes back through Brigade. Claude has no device flow: the dashboard opens Claude's page, Claude shows a
  one-time code, and the member pastes it into the dashboard. The API relays that code to the computer without storing
  or logging it. It is bound to a PKCE verifier that never leaves the computer, so it is useless on its own.
- **On the workspace computer a Claude account is a long-lived token.** There the runner signs in with
  `claude setup-token` (in a pseudo-terminal, as it draws a terminal UI) instead of `claude auth login`, and keeps the
  token it prints in `<account dir>/.oauth-token`, mode 600, readable only by the runner. Each turn gets it as
  `CLAUDE_CODE_OAUTH_TOKEN`. It lasts a year and never refreshes. `claude auth login` does not work there: its access
  token is short-lived and each refresh rotates the refresh token, while every teammate user has its own copy of the
  login, so the first teammate to refresh left the others with a dead one (a "Sign in again" ticket about once a day).
  The token is inference-only, so Brigade does not learn the account's plan, nor its email unless the member gives it
  with the sign-in code. A teammate can still see its
  own account's token, as it could see the shared login file before. Accounts signed in before still use their
  config-directory login until they are signed in again. On a member's machine (one user, one config directory)
  Claude's own login keeps working, and is still used.
- **The runner never sends a login anywhere, and reads none but those tokens.** The adapters get an empty auth
  environment (`auth: {}`), so they add no credential of their own; the vendor CLI uses the account's token or its
  login from the account's config directory.
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
  run commands as teammate users. Account logins live in `/var/lib/brigade/accounts`. A Claude account's token stays
  readable by the runner only and reaches a teammate in its turn's environment. Codex logins (and Claude logins from
  before tokens) are readable by teammate users (one trust zone, per the spec). Each teammate gets a private config
  directory per account that links only the login file, so conversation history stays private; a login refreshed
  during a turn is moved back to the shared place without being read.
- **Takeover.** Take over (after the current turn, or now) stops the teammate; prompts are refused meanwhile. The
  desktop comes from the provider. The terminal runs as the teammate in the thread's directory, through `script`, and
  is relayed over the runner's existing socket. Each command run is logged as a `terminal.command` event under the
  member's name. Hand back sends the note and the files changed since takeover as the teammate's next message.
- **Idle stop.** Every minute the API stops cloud computers with no running thread and no activity for
  `IDLE_STOP_MINUTES` (default 30). Commands for a stopped computer start it and wait in memory (10 minutes) until its
  runner reconnects. boat trial accounts also impose a 2-hour auto-stop (`BOAT_AUTO_STOP_SECONDS`).
- **Restarts.** A turn cut off when its computer or runner stops goes on by itself once the runner is back (protocol
  16). The welcome names, for each thread the API has as running or waiting there, the teammate whose turn it is
  (with its spec), and each message shown as queued (with its text and teammates). The runner continues each turn its
  saved harness state says was cut off (one waiting on a connector call's approval included), answers a message read
  but not yet answered, and closes a running thread with neither; then it queues those messages again in order. What
  its outbox still holds (a turn that ended, a message read or cancelled) is not redone. A stop the runner sees (`systemctl stop`, a reboot, an update) freezes the turn, which goes
  on where it stopped; on a cloud computer systemd signals the runner alone (`KillMode=mixed`) and waits up to a minute.
  After a stop without warning (power, out of memory, a crash) the harness resumes the conversation (Claude Code: the
  newest in the thread's directory, the cut-off turn included; Codex: its saved thread, else a new session told the
  thread so far) and the teammate is told to check what is already done before carrying on. A turn cut off by three
  restarts in a row is closed instead. A cloud computer its provider stopped while a thread ran is started again.
  A turn that failed on a passing error (a full disk, the network, Claude's API down or overloaded) is tried again
  on its own after 1, 5 and 15 minutes, a full disk only once 1 GB is free; a message, a stop or a person taking over
  cancels the next try. Any failed turn's error shows Try again, which runs the turn again (`thread.retry`, protocol
  33). Either way the teammate is told the error and to check what is already done before carrying on.
  The runner's state files are replaced whole, and an outbox line cut short is dropped, so a crash cannot keep it from
  starting. Not continued: a harness approval or question pending when the runner died without warning (as before,
  answering it fails), the later teammates of a message several were asked, and a turn whose start never reached the
  API before the runner died.
- **Commands to runners** (`apps/api/src/runner-commands.ts`). Each command with a `commandId` (a message, a
  person's answer, a retry, a takeover) is a `RunnerCommand` row before it is sent. It is still sent at once; the row
  is the safety net. Runners from protocol 43 (`OUTBOX_PROTOCOL`) acknowledge each by id (`command.ack`) and ignore an
  id they have seen (`apps/runner/src/seen-commands.ts`, kept on disk), so the API sends what is not acknowledged again
  when the runner says hello and, while it stays connected, two minutes after each send. Commands for a cloud computer
  that is starting wait in the table however long it takes, across API restarts, and a computer that never came up is
  started again each minute. A command not through in 24 hours fails and opens a ticket in its thread (a thread left
  starting goes back to idle); an interrupt or a browser window is dropped after 10 minutes instead, being moot. An
  older runner takes each command once, as before. Rows are deleted 3 days after they settle.
- **Vault.** AES-256-GCM, with each organization's key derived (HKDF) from `VAULT_KEY`; the workspace id is bound
  in as authenticated data, so a secret cannot be moved to another workspace. Decrypted only inside the API, per call.
- **Connector calls** (`apps/api/src/connector-calls.ts`). The runner passes granted operations to `HarnessAgent` as
  AI SDK tools; each `execute` sends `connector.call` over the runner's socket. The API checks the thread is on that
  runner's computer, the grant, read vs write, and the teammate's policy for writes (`allow`, `ask`, `deny`; default
  `allow`). `ask` opens an approval ticket and the call waits; the thread shows it as an approval, answered from the
  thread or the Tickets page by the thread's starter or an admin. Every call, refused ones included, is recorded in
  `ConnectionCall`. A call waiting for a decision (a write, a cap, a credential, a trigger) is a `HeldCall` row beside
  its ticket (`apps/api/src/held-calls.ts`): the decision is acted on whenever it comes, after any restart of the API
  or the runner, once (the row is claimed). Its result goes to the teammate's tool while that still waits on the same
  connection, else to the thread as a message, through a wake-up, as an email's reply does; a released secret never
  goes in one (the teammate is told to ask again, which the approval now allows). An identical call (same thread,
  teammate, tool and arguments) while the ticket is open joins it rather than open a second one, and a call cut off by
  a connection that dropped tells the teammate it still waits, not to try again. A decided call a restart left is
  made by the minute's tick; one a restart cut off while it was being made is not made again, and the thread is told
  to check. Vendor errors are scrubbed of anything that looks like a key or token before they are logged or
  returned, since Stripe echoes a masked key.
- **Connections** are kept as `removed` when disconnected, so their call log survives; the credential is revoked at
  the provider (Google) and deleted from the vault. Gmail and Google Calendar connect through Google OAuth; Stripe
  signs in on Stripe's MCP server (`mcp.stripe.com`, its own OAuth). Each call there names a Stripe account
  (`stripe_context`) and a mode (`livemode`); a Brigade account is one of each, as a key was: a sign-in that reaches
  several is refused, and Brigade adds both to every call (left out of the tools' schemas, a call naming others
  refused), so grants and triggers never reach an account added to the sign-in later. The server hides customers'
  details from keys (not from OAuth), so an account connected with a key before asks its owner to sign in again;
  signing in to the same account and mode takes its row over, with its access and triggers.
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
- **Awaited replies** (`apps/api/src/replies.ts`). An email a teammate sends with `gmail_send` from a member's
  thread (or its child) starts a `ReplyWatch` on its Gmail conversation, for 14 days after the last email it sent
  there; `gmail_send`'s result tells the teammate so it does not set a wake-up to check the inbox. The inbox reader
  hands each new email to the watches first: a reply in the conversation is a `Wakeup` of kind `reply`, fired at
  once with the email in a trigger event's form (the dashboard shows it as a mail), once per email. Automatic
  replies (`Auto-Submitted` and the like) wake nobody, and a thread woken `WAKEUPS_IN_A_ROW` times with no word
  from a person stops waiting. The mailbox is read while a watch runs even without triggers, and then only the
  awaited conversations' emails. The thread's panel lists them under Waiting for replies, where a member stops one.
- **Email** (`apps/api/src/mail/`, `connectors/email.ts`, `routes/email.ts`, design in `docs/email.md`). Agents'
  own addresses on Brigade's mail domain, received and sent through Resend: `riley@`, `riley.<project>@` per project,
  sign-up addresses for one thread, and projects' inboxes that a company's own address is forwarded to. Names are
  unique across Brigade and never given again. Each mail goes to one place: a thread waiting on it, its conversation's
  thread, a member's request, the address's first matching rule, or its box for 30 days. The Inbox (`src/inbox.ts`, `/app/inbox`)
  lists every mailbox's mail across agents, projects and sources (Brigade's addresses, Gmail), with where each went,
  and lets a person mark one done or hand it to a teammate.
- **Projects** (`apps/api/src/projects.ts`, `routes/projects.ts`, design in `docs/projects.md`). A project
  groups a workspace's work: threads, tasks, schedules and triggers carry a `projectId`; it owns a library folder
  and links repositories by `owner/name`. Everything else stays shared. A thread in a project gets its brief,
  memory (`projects/<id>.md`), folder, repositories and preferred connections in its spec; a quiet thread's
  memory run writes project facts there, never for a private thread. Lists take `?project=<id|none>`.
- **Schedules** (`apps/api/src/schedules.ts`, `routes/schedules.ts`, design in `docs/automations.md`). A teammate
  prompted with the same instructions on a cron schedule (five fields plus an IANA timezone, runs at least 5 minutes
  apart), each firing in a fresh thread on the accounts of the member who owns it. A minute tick moves `nextRunAt`
  with a conditional update, which is the claim: a firing starts once, and missed firings collapse into one. A firing
  is skipped while the previous run is still going; one that cannot start opens a ticket for the owner. Only the owner
  edits a schedule; admins may pause, run or delete it. Teammates create, list and change schedules with their tools,
  only from a member's thread (never a trigger's or a schedule's), owned by that thread's starter.
- **Subscriptions** (`apps/api/src/subscriptions/`). Brigade subscribes the vendor itself, synced whenever a
  connection's triggers or awaited replies change: a Stripe webhook endpoint per connection listing the events
  needed, made through Stripe's MCP server (which creates, updates and disables endpoints but deletes
  none: with no trigger left an endpoint is turned off and kept; its signing secret goes to the vault); the GitHub
  App's one webhook;
  a Gmail `users.watch` through Pub/Sub (`GMAIL_PUBSUB_*`, renewed before its seven days run out), or, without
  Pub/Sub, a check every minute; a Calendar push channel per watched calendar, renewed before it expires. Vendor
  pushes arrive at `/events/stripe/:id`, `/events/gmail` and `/events/google-calendar`, each verified: a Stripe
  event by its endpoint's signing secret, or, for an endpoint without one (the server hides it from keys), read
  again from Stripe on the endpoint's account, so only what Stripe has counts (at most 120 reads a minute per
  endpoint). Gmail and
  Calendar pushes only say something changed: the mailbox's history and the calendar's sync token say what; a read
  sets `Subscription.retryAt` first and clears it once done, so the minute's tick reads again after a failure or a
  restart that cut a read off. Stripe's events, a custom app's and the GitHub App's are kept as they come
  (`InboundEvent`, unique by source and the vendor's id, `apps/api/src/inbound.ts`), answered 2xx, then processed
  from the row, at once and again on the minute's tick (1, 2, 4… minutes, up to a day, then operators are alerted).
  A custom app's event without an `id` field or `X-Request-Id` counts once per body within five minutes. Each
  trigger takes an event once (`TriggerDelivery`, unique by trigger and event id, claimed before its thread starts,
  and taken over when a try failed or a crash left it starting for ten minutes), so retries and concurrent tries
  start one thread. Every ten minutes the GitHub App's deliveries of the last six hours that failed and were never
  kept are asked for again through GitHub's API. Resend's mail follows the same pattern in `MailMessage`.
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
  `~/.browser-tabs/<thread>.json`; tabs of threads idle for a day are closed. The desktop shows all the threads'
  tabs in the same windows, so watching a thread's desktop brings the tab it opened last to the front
  (`browser-focus.ts`, `browser.focus`), unless a person is using the screen: in control of a thread, or recording a
  task. Chrome starts without its "Restore pages?" bubble, since a stopped computer cuts it off.
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
- **Writing instead of answering.** A person may write to a teammate whose turn waits on its own ticket or
  question, to ask about it without declining it (`apps/runner/src/harness/aside.ts`, runners from
  `ASIDE_PROTOCOL`). The message goes in at once as the waiting call's result, which says the ask is still open;
  the ask stays open in the thread and in Needs you, and the turn that answers the message ends with
  `turn.completed`'s `waiting`, so the thread still waits on a person. The answer, whenever it comes, reaches the
  teammate as a message of its own. A call that waits on a decision (an approval before a built-in tool, an App
  write, a credential, a trigger) is not set aside: a message waits for the decision, as before.
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
- **Library** (`apps/api/src/library.ts`). Each save of a file writes its bytes to an object of its own in the one
  bucket, `<organization>/<workspace>/library-objects/<document id>/<object id>`, never changed after (`LibraryObject`,
  `apps/api/src/library-objects.ts`; Cloudflare R2 through its S3 API; without `R2_*`, development uses
  `apps/api/.bucket`). The file's row points to it (`Document.objectKey`), and that row update is the save's only
  commit, so a write that lands late (past its lock's lease, or from a save that crashed) is never read. A sweep every
  10 minutes finds objects at least an hour old that no file or version points to, and deletes them an hour later,
  bytes before their row; an hourly one lists each workspace's folder and deletes bytes no row names (a write that
  landed after its object was swept), with no time bound. Files not saved since keep their bytes at the legacy key,
  `<organization>/<workspace>/library/<document id>`, until their next save. `Document` keeps path,
  type, size, SHA-256 and the text (UTF-8 files, PDFs and Word, Excel and PowerPoint files; others are kept but
  not searchable). Any member uploads (files or a whole folder, or by dropping them on the page), edits, moves and
  deletes from the Library page; every change is audited. Folders exist through their files' paths, and as
  `LibraryFolder` rows when someone makes an empty one or sets access on it; moving a folder rewrites every path
  under it at once. Each file records who added it and who changed it last (a member, or a teammate and its
  thread). Every save leaves a `DocumentVersion` pointing to the save's object (versions from before have their bytes
  under `<organization>/<workspace>/library-versions/<id>`); saves by one author from one place within 10 minutes
  fold into one version, and the newest 50 are kept. A restore saves the old bytes as a new version. Deleting moves a
  file to the trash: its path becomes `.trash/<id>/<path>` (no live path starts with "."), so nothing else finds
  it; restore puts it back (beside a file that took its place), and the hourly sweep deletes it 30 days on. A file
  is served inline only for types that cannot run script (`Content-Security-Policy: sandbox` always); anything else
  downloads. Word documents, spreadsheets and decks are read on the API (`apps/api/src/previews.ts`) for previews:
  Word as HTML in a frame that runs no script, the first rows of each sheet, the text of each slide.
- **Editing documents** (`apps/web/components/document-editor.tsx`, `apps/api/src/collab.ts`, `apps/collab`). Markdown
  library files and memory open in one BlockNote editor, live: everyone with a document open sees the others'
  edits and cursors, and edits save as people type. Each document is a room on the collab server (a Durable
  Object, its Yjs state in SQLite); the API signs a 10-minute token for the room (`POST /api/library/edit`) and
  stays the only writer of documents. A room asks the API for the stored text as a Yjs update and saves its state
  back (`/collab/documents/:id`, authenticated by `COLLAB_SECRET`); the API converts with `@blocknote/server-util`
  and skips saves that only reformat. When a teammate or a thread writes a document, the API tells its room, which
  merges the change: the API diffs top-level blocks from the room's last saved state to the new text, so edits
  people have not saved yet survive. Without `COLLAB_SECRET`, the editor works alone with a Save button. Media: files dropped, pasted or picked
  into a document go to the bucket under `<organization>/<workspace>/assets/<id>` (`DocumentAsset`; direct
  uploads with R2, through the API without) and are read through 5-minute signed URLs, so video seeks. The document
  refers to them as `asset:<id>`. The hourly sweep removes files no document refers to after a day (a block copied
  into another document moves the file there), unfinished uploads after an hour, and a deleted file's at once.
  Mentions: `@` in a document names a library file, teammate, thread, connection or repository, stored as
  `@[label](kind:id)` like messages. `@brigade/editor` (`packages/editor`) holds the editor schema and the Markdown
  forms that survive a round trip (`![name](asset:id)`, `[name](asset:id "video")`), shared by the API and the web. It deploys
  with the other Workers on a push to `main` (`scripts/deploy/workers.sh`), with the API's `COLLAB_SECRET`; set
  the API's `COLLAB_URL` to the Worker's URL.
- **Library on computers** (`apps/runner/src/library.ts`). The runner keeps a read-only mirror per teammate, of
  only what it may read, at `<library>/bt-<teammate id>` under `/var/lib/brigade/library` on the workspace computer
  and `~/.brigade/library` on a member's machine: hard links into one store of the files' bytes (`.files`, by
  SHA-256, the runner's alone). On the workspace computer the root helper makes each mirror for the teammate
  user's own group, so no other teammate opens it; on a member's machine every teammate runs as the member, so
  the split keeps teammates to their folders but is not a security boundary. A teammate's mirror is filled
  before its first thread there. The runner fetches a manifest from `GET /runner/library` (runner token) on
  every connect, when the API sends `library.changed`, and every 15 minutes; runners before protocol 13 get only
  the files every teammate may read. A teammate's grant on the library is `read` (default) or `read_write`;
  folders override it: an admin sets a teammate's access to a folder (`LibraryFolderGrant`), and a restricted
  folder reaches only the teammates granted access to it or to a folder inside. The deepest folder with a rule
  wins (`libraryAccessFor` in `@brigade/contracts`). Search, `save_to_library` and the mirror all follow it, and
  the teammate's instructions name the folders where its access differs. Members see the whole library.
- **Designs** (`apps/api/src/designs.ts`, `@brigade/contracts` `design.ts`). A design is a library folder named
  `<name>.design` with `index.html` and `design.json` (title, description, design system, viewports, `boards`; a
  deck sets `kind: "slides"` and marks slides with `data-slide` and `data-notes`) at its top, and optionally
  `knobs.json`. `boards` lists its pages for the canvas (file, title, width, an optional height and place); without
  it, `designBoards` shows `index.html` once per viewport.
  Teammates make them as plain HTML in any harness. `check_design` renders the folder with the computer's Chrome
  (`apps/runner/src/design-shot.ts`, run as the teammate, the folder served on a private port) and returns
  screenshots per board (else per viewport) or slide and the page's errors; `save_design` saves the folder (one
  `save` call per file) with a rendered `thumbnail.png` when Chrome is there. It first asks the API which files a
  person edited since this thread last saved them (`library.call` `design_edits`) and refuses, saving nothing,
  unless `overwrite: true`; an API that does not know the question answers an error, read as none. The library
  shows each design folder as one item and in a Designs gallery (without design systems' previews, which their
  cards open), and opens it on a canvas beside the page or the thread (`components/design-view.tsx`,
  `design-canvas.tsx`): its boards pan and zoom, one frame per board, mounted near the view; an options set shows
  one row per option. Its page runs the
  teammate's script, so it is served only from `DESIGN_URL`, another host pointing at the API
  (`designs.localhost:<port>` in development), under a signed four-hour address (`POST /api/designs/view`, then
  `/v/<token>/...`), with a `sandbox` CSP that makes its origin opaque,
  `connect-src` limited to itself and public CDNs, and no form submissions. On that host nothing else of the API
  answers. Use a separate domain in production. The host numbers the elements a page's `<body>` was written with
  (`apps/api/src/design-source.ts`, parse5 source locations) and marks each `data-bid="<n>:<line>:<text
fingerprint>"`, sending the page `no-store`, and adds a bridge script first in its head
  (`apps/api/src/design-bridge.ts`), which the canvas talks to by `postMessage`. In Select a clear layer over each
  board takes the pointer and asks the page what is under it; the bridge describes an element (computed and
  inline styles, attributes, whether a person can change it: an element a script made, cloned or retyped is
  "made by the page's script"), reports the page's height (a page sized by `vh` keeps a screen's height and
  scrolls), forwards the wheel, shows changes before they are saved, retypes a text in place, tries knob values
  live, prints to PDF, and captures PNGs with html-to-image (html2canvas cannot run in an opaque-origin
  sandbox). A person's changes (inline styles, text, links and images) go to `PATCH /api/designs/edit` with the
  sha256 of the page they were made on: one at a time per file, refused with 409 when it was saved since,
  spliced into the original text and saved as a new version by the member (`design.edited` audit); the canvas
  undoes by sending the reverse change, and saves a new `thumbnail.png` (`PUT /api/designs/thumbnail`) after
  the first board's page changes. A comment is a message to the thread that saved the design last (the files'
  `updatedInSessionId`, when the member may prompt it), else a new thread to the same teammate. Knobs are saved
  into `knobs.json` (`PUT /api/designs/knobs`) and applied to the page as `:root:root` custom properties.
  Export: the folder as a zip (`GET /api/designs/zip`), PDF, PNG, and for decks PowerPoint (one picture per
  slide with its notes, pptxgenjs). A message mentions a design as `@[path](design:path)`; Hand off starts a
  thread that builds it. **Design systems** are `DesignSystem` rows over a library folder (`README.md` rules,
  `tokens.css`, assets, an optional `preview.design`), shown under Library → Design systems. Each says where it
  applies: library folders, repositories, teammates, or the workspace default. Every thread's spec carries the
  catalog, and the teammate's instructions say how to pick one: named in the message, then folder, repository,
  teammate, default; it asks when none applies. A teammate makes one with `save_design_system`: it saves the
  folder, then a `library.call` registers it (by name, so saving again updates it), which needs write access to
  that folder and is audited as the teammate; the workspace's first is the default. "Ask a teammate" under Library
  → Design systems drafts that thread.
- **Memory** (design in `docs/memory.md`) is four kinds of Markdown `Document` with no bucket object: workspace
  (`workspace.md`), project (`projects/<id>.md`), teammate (`teammates/<id>.md`) and thread summaries
  (`threads/<id>.md`). A memory file is in layers: the lines before its first `## ` heading are its core, which every
  thread loads; each `## ` section is a topic, which a thread reads when its work touches it (`parseMemoryFile` in
  `@brigade/contracts`). Each line has a `MemoryLine` row, kept by its text: when and in which thread it was learned,
  whether a person wrote it, when a thread last confirmed it, and once it left the file, why (the archive). The rows
  follow the text on every write, a person's included (`planLineSync`); a line a person takes out minutes after
  writing it was a draft and leaves no archive.
- **Loading memory.** The runner writes `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex) into the thread's directory
  each time a harness session starts, with each memory's core, every line ending with its date, and its topics as
  files in `.brigade-memory/`, listed by name, description, size and path (`memory-layers.ts`). What every thread
  loads is the size of the cores (4,000, 5,000 and 3,000 characters), however much memory holds; a core far past its
  budget, before a tidy run fixes it, keeps its newest lines and puts the older ones in a topic file. A file of that
  name Brigade did not write is left alone. Codex is allowed to read all of a long AGENTS.md (`project_doc_max_bytes`).
  Lines other threads teach while a session runs are told at the start of its next turn, once (`memoryNews`); a parked
  session loads them when it resumes.
- **When a thread ends** is when it goes quiet: 5 minutes after its last turn (`BRIGADE_QUIET_MS` overrides, for
  tests), the runner runs the thread's harness once more, outside the thread, with no tools, on the same account,
  in an empty directory (`memory.ts`). It reads what was said since the last time and each memory file it may change
  whole, its lines numbered and dated under their core or topic, and answers with a summary and, per file, new
  lines with their topic, corrected lines (`replace`), lines to archive with why, and lines it found still true
  (`confirm`, which moves their date). Memory is not a log: at most three new lines a file per run, only what a
  teammate would need in an unrelated thread and could not find with its tools (never the thread's progress, what
  Brigade or a repository already shows, or what emails and websites said). The API applies the edit
  (`changeMemoryFile`) one file at a time, so threads ending together never overwrite each other or people's edits.
  A private thread (set by its starter) leaves workspace and project memory alone, and its summary is searchable
  only by the starter. One-off runs like this one use Claude Code's 5-minute prompt cache, since their prompt is read
  once.
- **Tidy runs** (`memory-tidy.ts`) lay a memory file out again when its core is past budget, the file past 40,000
  characters, a file never tidied reaches 30 lines, or a week after the last tidy once lines changed; never twice in
  six hours. The run, on the account of the thread that went quiet and beside it rather than in its queue, answers
  with the core, the topics with their descriptions, merges and lines to archive with why (`memory.tidy`; the API
  drops it when the file was tidied again since, `layOutMemoryFile`). A layout that would take away more than 40 % of
  the file (60 % past 40,000 characters) is not applied. Lines it leaves out stay where they were.
- **The archive** holds the lines removed from memory: replaced, merged, outdated or removed by a person. Teammates no longer load them;
  `search_workspace` and the dashboard's search find them, and the Memory tab lists them per file, with why, when,
  by whom and the thread they were learned in, and puts one back under its topic.
- **Search** is PostgreSQL full text: a generated `tsvector` (path weighted over text; `english` stemming for text,
  `simple` for paths) with a GIN index, queried with `websearch_to_tsquery`; archived memory lines have their own,
  and a few come after the files. Teammates get `search_workspace` (answered like a connector call); a teammate
  finds its own memory, never another teammate's.
- **Code from GitHub** (`apps/api/src/git.ts`, `apps/api/src/routes/git.ts`, `apps/runner/src/repos.ts`). GitHub is
  the source of truth; a computer's disk is a cache. Git reaches GitHub only through the API, which proxies git's
  smart HTTP protocol at `/git/<owner>/<name>.git` and adds the installation token there, so no GitHub credential
  reaches a computer (hard constraint 4). A teammate granted a GitHub connection gets `git` in its thread spec: the
  proxy URL and a token signed by the API (HKDF from `BETTER_AUTH_SECRET`, 7 days) naming the thread, teammate and
  computer. Every request is checked again: the thread on that computer, the teammate in it, a grant whose
  installation reaches the repository (public repositories outside any installation are readable anonymously, so
  dependencies keep working). Pushes need a `read_write` grant and a policy other than `deny`, count toward the write
  cap, and may only update branches under `brigade/` or create a tag (never move or delete one) whose commit is
  already on the default branch, checked with GitHub's compare API, so a lightweight tag (an annotated tag's object
  isn't on GitHub before the push); anything else is refused the way GitHub refuses a protected branch
  (`! [remote rejected]`). Propose changes with `github_create_pull_request`, which asks as usual. Each clone or
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
- **Thread folders as a cache** (`apps/runner/src/folders.ts`, cloud computers, every 5 minutes). Threads never end,
  so a computer cannot wait for them to: once `/home` is 80% full (space or inodes), the runner archives the folders
  of the threads quiet longest (none active in the last hour, in use, or with a preview) until it is down to 65%. The
  archive keeps each git repository's `.git` and every file but those in folders git ignores (`.env` stays;
  `node_modules`, `dist`, `.venv`, `target` go), and everything outside repositories but `node_modules`. It is written
  to a file and streamed to R2 through a signed URL (`POST /runner/folders/<thread>/<teammate>/upload`, up to 4 GB;
  through the API up to 200 MB without R2), and the folder is removed only once `…/done` finds all of it in the
  bucket. Going back, `GET` redirects to a signed URL and the runner streams it to a file. Whatever next needs it (a turn, a
  preview started from the dashboard, a takeover, a terminal, a file read) puts it back first and deletes the
  archive; the teammate's next turn fetches the caches its checkouts borrow from if they were swept, and is told to
  reinstall dependencies. A folder that cannot be put back stops the turn rather than start over in an empty one.
  Disk then grows with the threads active at once, not with all threads.
- **Containers by thread** (`apps/runner/src/containers.ts`, cloud computers). Each teammate's rootless Docker is shared
  by its threads, so each thread gets its own Compose project (`COMPOSE_PROJECT_NAME=t<thread id>`, for the harness,
  previews and takeover terminals): two threads on one repository no longer share containers or a database volume. A
  container belongs to the thread whose folder holds its Compose file or is mounted into it, or whose project it is.
  On the same 5-minute check, the running containers of threads quiet for an hour (and not in use) are stopped, data
  kept, and the teammate's next turn is told to start them again. Archiving a thread's folder first removes its
  containers and their volumes. When the disk is full, each teammate's Docker is pruned (`docker system prune --all
--volumes`: what no container uses) before any folder is archived.
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
  for older ones, the call log by branch), its review and where a merge a person asked for stands. The list reads,
  live from GitHub, every repository where a teammate opened a pull request; a person's pull request elsewhere is
  not listed. A pull request's page shows its description, checks, reviews and diff. Until the workspace has a
  working GitHub connection, the page shows how to connect one. Any member asks a teammate to review a pull
  request; only owners and admins merge. Teammates merge only when a person asks. A pull request that conflicts
  goes back to the teammate that wrote it (Resolve conflicts): when its turn ends, Brigade merges it once GitHub
  allows it, checked every minute; failed checks and new conflicts go back to the author, three turns at most,
  then a ticket. Merges are squash by default, audited as `pull_request.merged`.
- **Reviews** (`apps/api/src/reviews.ts`). Another teammate reviews a pull request in a child thread of the thread
  that opened it, which Brigade starts with a standard brief rather than the author's: the pull request, how that
  thread started, and whether the repository runs checks (then the reviewer reads the logic and leaves the rest to
  them; without, it also runs the typecheck and the tests). The reviewer is another teammate that can post on the
  repository, preferably on another model than the author's; with nobody else, the author itself in a fresh
  context. Its verdict (`github_review_pull_request`) is posted on GitHub and kept as a `PullRequestReview`; its
  report wakes the author, which fixes what it rightly found and asks it to look again (`message_thread`) while each
  look finds fewer problems that block the merge, and stops to tell the person what is open once it goes in circles
  (a fixed problem back, a disagreement that outlasts one exchange). A review takes 8 looks at most
  (`REVIEW_LOOKS`): past them, the API refuses `message_thread` and the author's `request_review`, and only a person
  has it read again (Review again). The pull request waits on a person (Needs you, with one push) once its review is done. A project's
  Code review setting (`Project.reviewPolicy`) says who decides there is one: the teammate that opens a pull
  request, in `github_create_pull_request`'s `review` (wanted, and a reason shown on it), or only someone who asks
  (`request_review` in the thread, or Ask for a review on the pull request's page). A child thread asks its parent
  for one in its report, and its pull request's review reports to the parent; a playbook's run starts none on its
  own. One opened outside Brigade is reviewed in a thread of its own, which becomes the pull request's. Closing a
  pull request stops its review; one merged meanwhile keeps it, as what it finds is still worth a follow-up. Every
  teammate acts as the GitHub App, and GitHub refuses a verdict on the app's own pull request, so there a review is
  a comment that starts with the verdict, and the verdict itself lives in Brigade. A repository requiring an
  approving review needs a person to approve on GitHub, or the app allowed to bypass the rule.
