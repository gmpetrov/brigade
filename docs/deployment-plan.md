# Deploying on a VPS and on Cloudflare: plan

Brigade deploys two ways from one codebase:

- **VPS**: one server running Docker Compose. Cloudflare is used only for DNS, if at all.
- **Cloudflare**: `apps/api`, `apps/web` and `apps/collab` run as Workers. Durable Objects
  hold the WebSockets, R2 holds files, and Hyperdrive connects to PostgreSQL. No
  Containers.

The code stays the same on both. What differs sits behind a few seams: one module per
platform for each thing that differs, and one entry file per platform. Most of the work
also improves the VPS (no state lost on restart, jobs safe to run twice, big uploads
streamed), so the VPS ships first and the Cloudflare entry comes last.

Research was done on 2026-10-14. It included a trial run of the API in local workerd on a
copy of the repo; the findings below come from there.

## What runs in production (2026-10-14)

Cloudflare shipped first, more simply than the phases below:

- **One Durable Object for the whole API.** `apps/api/src/worker.ts` forwards every request
  to a single `Api` object, which runs the Hono app as the one Node process does. The hub,
  the timers (`src/jobs.ts`) and a Prisma client with its pool all live in that object. A
  Cron Trigger pings it each minute so the jobs keep running. Phase 3 (a hub per
  workspace) is needed only once one object is not enough.
- **Next to the database.** A request makes about ten queries, each a round trip from the
  `Api` object to Neon in Frankfurt, so where the object runs counts most.
  - An object stays in the data center it was created in, near the Worker that first
    asked for it. The Worker's placement (`aws:eu-central-1` in `wrangler.jsonc`) runs it
    near the database, so the object was created there.
    - A query takes 2 to 3 ms there. The first object, created with the `weur` hint
      instead, landed in Amsterdam: 13 ms per query.
    - Changing the object's name in `src/worker.ts` creates a new one.
  - pg-cloudflare is patched (`patches/`) to send each query in one write. Before, each
    query waited about 70 ms for Nagle's algorithm and delayed ACKs.
  - Hyperdrive is not used. The object keeps its connections open, so Hyperdrive's fast
    connection setup would not help, and its cache would serve reads older than the
    latest writes.
- **Platform seams.** `src/platform/node.ts` and `src/platform/workers.ts` hold what
  differs. wrangler's `alias` swaps in three Workers versions: that module, Prisma's
  `runtime = "cloudflare"` client, and jsdom, replaced by linkedom
  (`src/platform/jsdom.workers.ts`). On six documents, linkedom gave the same Markdown
  conversions as jsdom.
- **Hosts.**
  - `www.brigade.lol`: the dashboard, on OpenNext, with a patch for Next 16.4's
    `preview-props.json`. `brigade.lol` redirects to it.
  - `api.brigade.lol` and `designs.brigade.lol`: the API.
  - `collab.brigade.lol`: live document sync.
  - Files go to the R2 bucket `brigade`.
- **Deploy** happens on each push to `main`. Workers Builds, Cloudflare's GitHub
  integration, runs one build per Worker (`brigade-api`, `brigade-web`, `brigade-collab`):
  - Each runs from the repository root, with Node from `.nvmrc` and `PNPM_VERSION`
    `8.7.5`. It installs, then runs `pnpm run cf:build:<worker>` and
    `pnpm run cf:deploy:<worker>`. Both call `scripts/deploy/workers.sh`.
  - Watch paths limit each build to the files it is built from.
  - The API's deploy migrates the database first, with the `DATABASE_URL` build secret.
  - A deploy keeps the secrets a Worker has, and no file in the repository holds them:
    - `brigade-api` reads all its settings from secrets.
      `pnpm --filter @brigade/api exec wrangler secret list` names them.
    - `brigade-collab` has `COLLAB_SECRET`, the same as the API's.
    - To change one, run `pnpm --filter @brigade/api exec wrangler secret put <NAME>`
      (`@brigade/collab` for collab), or use the Worker's Settings in the dashboard. The
      Worker restarts with it at once.
    - `DATABASE_URL` is also a build secret of `brigade-api` (Settings > Build), for the
      migrations. Change both together.
  - The R2 bucket was set up once, with `wrangler r2 bucket create brigade --location weur`
    and `wrangler r2 bucket cors set brigade --file scripts/deploy/r2-cors.json`.
  - To deploy from a laptop instead, sign in with `wrangler login` and run the same
    `pnpm run cf:build:<worker>` and `pnpm run cf:deploy:<worker>`. The API's deploy needs
    `DATABASE_URL` set.
  - Build logs are under each Worker's Deployments in the dashboard, and a check on the
    commit in GitHub.
  - A new version can take a few minutes to reach the running `Api` object; until then
    it keeps serving the previous version.
  - The runner bundle comes out the same for the same code, so runners update only when
    the runner changed.

## What runs on the VPS (2026-10-14)

A second deployment, on a Hetzner ARM server (2 vCPUs, 4 GB), with the same settings as
Cloudflare's except its URLs and its database: a Neon database of its own, in Frankfurt
like the server. Its accounts, workspaces and computers are its own; a computer's runner
connects to one API, so the two could not share them. It shares Cloudflare's R2 bucket,
where each file's key is its own id and only a database row deletes it.

- **Hosts.**
  - `vps.brigade.lol`: the dashboard.
  - `api.vps.brigade.lol` and `designs.vps.brigade.lol`: the API.
  - `collab.vps.brigade.lol`: live document sync.
- **Images** (`deploy/vps/Dockerfile`, built together by `deploy/vps/docker-bake.hcl`):
  - `api`: the Node entry (`dist/index.js`) with the runner bundle, and the Prisma CLI
    for migrations.
  - `web`: Next's standalone server. `NEXT_STANDALONE` turns that output on, and the
    VPS API's URL is built in.
  - `collab`: the collab Worker itself, bundled by wrangler, in workerd (Cloudflare's
    open-source runtime, `deploy/vps/collab.capnp`). Its rooms are kept in SQLite on a
    volume. It is the same code as on Cloudflare, not a port to Node.
- **On the server** (`/opt/brigade`, `deploy/vps/compose.yml`): `api`, `web` and
  `collab`, behind the server's Traefik (Coolify's proxy). Traefik routes by the
  services' labels and gets the certificates from Let's Encrypt. Secrets are only in
  `api.env` and `collab.env` there, readable by root alone.
- **Deploy** happens on each push to `main` that touches what the images are built from
  (`.github/workflows/vps.yml`):
  - The workflow builds the images on an ARM runner and pushes them to GitHub's
    registry, tagged with the commit.
  - Over SSH, it runs `deploy/vps/deploy.sh` on the server: pull, migrate, restart.
  - It needs the `VPS_SSH_KEY` secret (a key only for this) and the `VPS_HOST` and
    `VPS_KNOWN_HOSTS` variables.
  - To go back, re-run an earlier deploy: the server keeps a week of images.
- **Outside the repository:**
  - The Google OAuth client allows `https://vps.brigade.lol` and the VPS callback.
  - The Pub/Sub subscription `brigade-gmail-push-vps` pushes Gmail changes to the VPS API.
  - The R2 bucket's CORS rules allow the VPS dashboard.
- **GitHub:** the GitHub App has one setup URL, the Cloudflare API's, so connecting
  GitHub from the VPS dashboard ends on Cloudflare. The VPS needs a GitHub App of its own
  for that (its `GITHUB_APP_*` settings).

## Where each part runs

| Part                                                              | VPS                                                | Cloudflare                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/web`                                                        | Next `output: 'standalone'` in Node                | OpenNext (`@opennextjs/cloudflare`) Worker                          |
| `apps/api`                                                        | `src/index.ts` on Node, one process                | `src/worker.ts` Worker, with a `HubDO` Durable Object per workspace |
| WebSocket hub                                                     | `WorkspaceHub` objects in a Map in the API process | `WorkspaceHub` inside `HubDO`, using the Hibernation API            |
| Jobs (schedules, merges, inboxes, idle stop, sweeps)              | `setInterval`                                      | `scheduled()` Cron Triggers                                         |
| Collab                                                            | `apps/collab` Node server, rooms saved in Postgres | `apps/collab` Worker as today (`DocRoom` Durable Object)            |
| PostgreSQL                                                        | `postgres:17` container, or Neon                   | Neon through Hyperdrive                                             |
| Library files                                                     | MinIO or Garage (S3 API) on its own host           | R2 (S3 API through aws4fetch, the same code)                        |
| Runner bundle                                                     | file in the API image                              | R2 object, with its SHA-256 stored in the object's metadata         |
| Work that takes longer than one request (provisioning a computer) | runs in the background in the process              | a Cloudflare Workflow                                               |
| TLS and hosts                                                     | Caddy                                              | Custom Domains                                                      |

## Hosts

| Host                                             | Serves                                                      | VPS            | Cloudflare                              |
| ------------------------------------------------ | ----------------------------------------------------------- | -------------- | --------------------------------------- |
| `www.brigade.lol` (`brigade.lol` redirects here) | dashboard and landing page (`WEB_URL`)                      | Caddy → web    | Custom Domain → web Worker              |
| `api.brigade.lol`                                | API, WebSockets, git, webhooks, OAuth callbacks (`API_URL`) | Caddy → api    | Custom Domain → api Worker              |
| `collab.brigade.lol`                             | live document editing (`COLLAB_URL`)                        | Caddy → collab | Custom Domain → collab Worker           |
| designs host (`DESIGN_URL`)                      | teammates' designs, sandboxed                               | Caddy → api    | Custom Domain → api Worker              |
| `files.brigade.lol`                              | the bucket, for presigned uploads and downloads             | Caddy → MinIO  | not needed (presigned URLs point at R2) |

`www.` and `api.` count as the same site, so the default session cookies work and
`CROSS_SITE_COOKIES` stays off. The designs host should be on another registrable domain
(for example `brigadeusercontent.com`), not `designs.brigade.lol`. The CSP sandbox already
keeps a design's script from reading cookies, calling the API or submitting forms
(`designs.ts:432`). But on a subdomain, the page is still on the same site as
`api.brigade.lol`. Its image and script tags would then send the session cookie with GET
requests to the API, which a different domain prevents.

## Works on both already

Checked on workerd with `nodejs_compat`:

- The Hono app.
- `node:crypto`: hashes, HMAC, AES-GCM in the vault, RSA signing for the GitHub App, and
  JWK verification for Gmail.
- `Buffer`, `node:path` and `process.env`.
- better-auth's sign-in, and Prisma queries through `@prisma/adapter-pg`.
- aws4fetch presigning; fflate and parse5.
- Webhook signature checks (they use the raw body), and OAuth state (it's stored in the
  database).

The git smart-HTTP proxy (`routes/git.ts`) uses only `fetch` and `Buffer`. It should work
but hasn't been run yet.

The 10 MB compressed limit on Worker size was removed on 2026-09-04. The limit is now
64 MiB uncompressed. After the Prisma and BlockNote changes below, the API is 5.3 MiB of
JS plus a 3.3 MiB wasm file. What to watch instead is the 1 s limit on startup work.

## The seams

These live in `apps/api/src/platform/{node,workers}`. A package.json `"imports"` entry
picks between them with the `workerd` condition, which wrangler resolves (its build
conditions are `workerd`, `worker` and `browser`).

| Seam                                              | Node                             | Workers                                                                               |
| ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `#prisma`: the generated client                   | `prisma-client`, default runtime | a second generator block with `runtime = "cloudflare"`; one client can't load on both |
| `db()`: the Prisma client for this request        | the one client                   | a new client per request, held in `AsyncLocalStorage`, on `env.HYPERDRIVE`            |
| `upgradeWebSocket`                                | `@hono/node-server`              | `hono/cloudflare-workers`                                                             |
| `connectSocket(url, headers)`: outbound WebSocket | the `ws` client                  | `fetch` with `Upgrade: websocket`, `binaryType = 'arraybuffer'`                       |
| `background(promise)`                             | `void p.catch(log)`              | `waitUntil` from `cloudflare:workers`; 30 s cap                                       |
| `jobs`                                            | `setInterval` per job            | `scheduled()`; crons `* * * * *` and `0 * * * *`                                      |
| `hub(workspaceId)`                                | the `WorkspaceHub` in the Map    | DO RPC to `HubDO.getByName(workspaceId)`                                              |
| `RunnerBundleStore`                               | the file at `RUNNER_BUNDLE_PATH` | R2, with the SHA-256 in metadata                                                      |
| `markdownDom`: Markdown conversion for collab     | `ServerBlockNoteEditor` (jsdom)  | to be decided; see Unknowns, item 1                                                   |
| `longTask(name, input)`                           | run in the background            | a Workflow                                                                            |

`db.ts` keeps exporting `prisma`, but as a Proxy over `db()`. That way the 53 files that
import it don't change, and better-auth can still read the data model when the module
loads. The proxy was tried on workerd: 5 sequential and 6 concurrent sign-ins all worked.
A client shared across requests hung on every second request.

## Phase 1: the VPS (3–4 days)

### Build fixes, needed by both

1. Pruned builds leave out `tsconfig.base.json`: `turbo prune --docker` doesn't copy it,
   and every package extends it. Add it to `globalDependencies` and set
   `futureFlags.pruneIncludesGlobalFiles` (read the installed turbo docs first, per
   AGENTS.md), or `COPY` it in the Dockerfile.
2. `prisma generate` fails without `DATABASE_URL`, because `apps/api/prisma.config.ts:14`
   calls `env('DATABASE_URL')`. Allow it to be missing for `generate`.
3. `patches/` only matters to `apps/runner`. The pruned api, web and collab trees have no
   patched dependencies.

### File storage

`bucket.ts` gets `S3_ENDPOINT` (by default the R2 address it builds today) and an optional
`S3_REGION`. The hardcoded `region: 'auto'` goes: aws4fetch guesses `auto` for R2 and
`us-east-1` for other hosts. Requests are already path-style.

On the VPS, run MinIO (or Garage) on its own host, `files.example.com`:

- Browsers upload and download through presigned URLs, and the signature covers the
  `Host` header. So the reverse proxy must pass `Host` through unchanged.
- The bucket's CORS rules must allow `PUT` and `GET` with `Content-Type` from the
  dashboard's origin.

### Dashboard

- In `next.config.ts`, set `output: 'standalone'` and point `outputFileTracingRoot` at the
  repo root.
- `NEXT_PUBLIC_API_URL` is inlined at build time, so pass it as a Docker build argument
  and build one image per environment.

### Collab on Node

1. Move `DocRoom`'s logic out of `apps/collab/src/index.ts` into a `Room` class that takes:
   - a storage interface, `RoomStorage { load, save(state, base, sha), clear }`;
   - the API client;
   - a way to list its connections.

   `verify` and `fromApi` (lines 19–58) need only WebCrypto, so they're shared as they are.

2. The Worker wraps `ctx.storage.sql`. Nothing else changes on Cloudflare.
3. Add `src/node.ts`, a Node server of about 150 lines built on `ws`, `yjs`,
   `y-protocols` and `lib0`:
   - **URL and access:** it serves `/parties/doc-room/<id>` with the same token check.
     It returns 503 when `COLLAB_SECRET` is shorter than 32 characters.
   - **API notices:** it takes the API's `POST` notices (`refresh` or `delete`) with the
     Bearer secret.
   - **Protocol:** it speaks sync (0) and awareness (1). It ignores string frames:
     nothing sends `__YPS:` messages.
   - **Rooms:** it holds a room's messages until the room has loaded, and closes idle
     rooms after saving them.

   `y-partyserver`'s server can't be reused, because it imports `cloudflare:workers`.

4. On Node, rooms are saved in Postgres, in a separate schema (`collab.rooms(id, state,
base, sha)`) so that `prisma migrate dev` doesn't see it as drift.
5. The dashboard passes only `url.host` to the provider. So collab needs its own host
   (`collab.example.com`), not a path under another one.

### Packaging

- **Images:** one Dockerfile each for `api`, `web` and `collab`. Each prunes with
  `turbo prune <pkg> --docker` (tested with pnpm 8.7.5: the install works offline).
- **Runner bundle:** a separate stage prunes `@brigade/runner` and runs `bundle.sh`. The
  tgz (16.6 MB) is copied into the API image, at `RUNNER_BUNDLE_PATH`.
- **Migrations:** `prisma migrate deploy` runs as a one-off container from the builder
  stage (`prisma` is a dev dependency).
- **Compose services:** `caddy`, `web`, `api`, `collab`, `postgres` and `minio`, each with
  `restart: unless-stopped` and log rotation.
- **Hosts:** `app.`, `api.`, `collab.` and `files.example.com`, plus designs on a separate
  domain that points at `api`. `app.` and `api.` count as the same site, so
  `CROSS_SITE_COOKIES` stays off.
- **Backups:** a nightly `pg_dump` and a mirror of the bucket, both off the server. Keep
  `VAULT_KEY` off the server too: without it, stored credentials can't be read.

## Phase 2: portable groundwork (about 1 week, ships on the VPS)

None of this changes behaviour on Node.

1. **`background()`** replaces work fired after a response with `void`:
   - `routes/github-webhook.ts:146` and `:149`
   - `collab.ts:62`
   - `library-history.ts:267`
   - `pull-requests.ts:932`
   - `subscriptions/google-calendar.ts:223`
   - `subscriptions/gmail.ts:140` and `:256`

   Provisioning (`cloud.ts:49`, up to 600 s) and start-and-poll (`cloud.ts:107`) go
   through `longTask()` instead.

2. **A jobs registry, `{ name, everyMinutes, run }`.** Each run first takes a lease, a row
   in Postgres claimed with `UPDATE … WHERE until < now()`. Two runs at once are
   currently unsafe for the merge watcher (`pull-requests.ts:1194`: it can send a pull
   request back twice) and for the subscriptions tick (`subscriptions/index.ts:88`: two
   readers share one cursor). The jobs:
   - the schedules tick (1 min);
   - the merge watcher (1 min);
   - the subscriptions tick (1 min);
   - `stopIdle` (1 min);
   - the sweeps (hourly).

   The runner update offer (`hub.ts:176`) stays on Node only. On Workers, every deploy
   reconnects runners, and their hello already carries the bundle version.

3. **State shared between requests moves out of memory:**
   - `cloud.ts:17` `lastActive` → `Computer.lastActiveAt`, written at most once a minute.
   - The `retryAt` values in `gmail.ts:94` and `google-calendar.ts:147` → database
     columns.
   - `connectors/google-calendar.ts:69` `own` → a table. Without it, a teammate's own
     calendar edits trigger it again.
   - `cloud.ts:154`, `:190`, `:223` and `:259`: the in-flight and "already tried" markers
     → columns.
4. **Locks become `pg_advisory_xact_lock` or conditional updates:** `subscriptions/common.ts:36`,
   `designs.ts:490` and `collab.ts:83`. Awaiting another request's promise doesn't work
   across isolates.
5. **The desktop proxy** (`desktop-proxy.ts:17` `views`): the view id becomes a sealed
   AES-GCM token holding `{ origin, cookie, exp }`, so the upgrade request doesn't need the
   Map. The relay uses `connectSocket()`.
6. **Large bodies stream** instead of being held in memory (a Worker has 128 MB, shared
   between its requests):
   - the designs zip (`designs.ts:372`, up to 100 MB plus its output);
   - previews (`previews.ts:13`);
   - runner backups (`runner-backups.ts:60`, plus a copy in `bucket.ts:151`);
   - `runner-attachments.ts:56`.
7. **Small fixes:**
   - **mammoth:** pass both `buffer` and `arrayBuffer` (`previews.ts:188` and `:205`).
     Workers load mammoth's browser build, which reads only `arrayBuffer`.
   - **`config.ts:21` and `:64`:** these defaults use `import.meta.url`, which is
     undefined on workerd. The Node entry fills them in instead.
   - **`RunnerBundleStore`:** used by `runner-install.ts`, `hub.ts:177`, `hub.ts:332` and
     `cloud.ts:237`.
   - **boat SDK:** pass `fetchApi: fetch` (`@boatdev/sdk` imports `node:http2`).

## Phase 3: one hub per workspace (about 2 weeks, ships on the VPS)

Every runner socket and every browser socket belongs to exactly one workspace. So the hub
splits by workspace with almost no changes to how it behaves.

1. **A `WorkspaceHub` class** holds the logic now in hub.ts, without module-level state.
   It runs on a small host interface:
   - `sockets(tag)`, where each socket has `send`, `close` and an attachment;
   - `kv`;
   - `timer(key, ms, fn)`;
   - `waitUntil`.

   On Node, the host is a Map of hubs with sockets in memory. Lines 624–1057
   (`storeEvents`, `statusAfter`, the `note*` helpers, `queuedMessagesOn`) only use Prisma
   and move over unchanged.

2. **Socket tags:** `runner:<computerId>`, `member:<id>` and `tab:<uuid>`. A browser's
   scope, open threads and terminals go in its socket's attachment (up to 16 KB). The
   runner's connection, including a "hello done" flag, goes in the runner's attachment.
3. **One `request(computerId, msg, timeoutMs)`** replaces the four request/response maps:
   `clipboards`, `fileReads`, and preview `starts` and `logReads`.
4. **Logins, the queue and terminals:** `logins.ts:18` `byLoginId`, `queued`
   (`hub.ts:152`) and `terminals` (`hub.ts:1141`) move into the hub's `kv`.
5. **Approvals that can be resumed.** Today an open promise waits for the approval, for
   hours if need be (`connector-calls.ts:35`, awaited at `:178` and `credentials.ts:266`).
   Instead, the pending call is stored, and `decideTicket` finishes it through the hub. An
   open promise would also stop a Durable Object from hibernating.
6. **Call sites:**
   - `isOnline`, `runnerProtocol`, `sendToRunner`, `readThreadFile` and `desktopClipboard`
     get a `workspaceId` parameter.
   - 17 call sites that use a result gain an `await`.
   - 32 that don't become `background()`.
   - `computers.ts:37` moves to a batch call.
   - `sendToMember` (`hub.ts:228`) is scoped to the workspace.
7. **Authentication stays outside the hub.** `hashToken` and `authenticateRunner` move out
   of hub.ts.

## Phase 4: the API on Workers (1–2 weeks)

1. **Prisma: two generator blocks**, one with `runtime = "cloudflare"`, behind `#prisma`.
2. **`src/worker.ts`:**
   - `fetch` wraps each request in its own Prisma client, connected to
     `env.HYPERDRIVE.connectionString`. A direct connection would cost 300–500 ms per
     request.
   - `/api/ws` and `/runner/ws` authenticate in the Worker, then forward to
     `env.HUB.getByName(workspaceId)` with the scope in an internal header.
   - `scheduled()` runs the jobs.
3. **`HubDO`** hosts `WorkspaceHub`:
   - It uses `acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `getWebSockets(tag)`
     and `ctx.storage`.
   - It opens a database client per event and closes it, because an open pg pool keeps a
     Durable Object from hibernating.
   - Each socket's messages stay in order: input gates open during Postgres I/O.
4. **Workflows** for provisioning and starting computers (`longTask`).
5. **wrangler.jsonc** for the API:
   - `nodejs_compat` and a recent compatibility date;
   - Hyperdrive, R2 and `HUB` bindings, and the Workflow;
   - a service binding to collab (a fetch to another Worker on the same zone through a
     route fails);
   - the two crons;
   - `limits.cpu_ms`, raised for password hashing, which is pure-JS scrypt.
6. **Limits:**
   - Request bodies are capped at 100 MB on Free and Pro zones. Very large git pushes
     will get a 413.
   - A deploy restarts every Durable Object, and runners and tabs reconnect.
   - Desktop sessions get a 20-minute grace period during runtime updates.

## Phase 5: the dashboard and collab on Cloudflare (2–3 days)

1. **`apps/web` with `@opennextjs/cloudflare`.** It supports Next 16, and the dashboard
   uses nothing it lacks:
   - no `proxy.ts` or middleware;
   - no route handlers or server actions;
   - no `next/image`;
   - no ISR.

   30 of the 34 pages are client components, and heavy libraries load lazily. Cloudflare
   now recommends vinext (beta) for Next 16 apps. Prefer OpenNext until vinext is stable.

2. **`apps/collab`:** deploy as today. Set `API_URL` and the `COLLAB_SECRET` secret, and
   bind to the API by service binding.
3. **R2:**
   - the library bucket, with CORS for the dashboard's origin;
   - the runner bundle, uploaded by the deploy job with its SHA-256.

   The installer follows redirects and reads `x-bundle-sha256`, so a 302 to a presigned
   URL works.

4. **CI:** a job per target. VPS: build the images, push them to GHCR, then over SSH run
   `docker compose pull && up -d`. Cloudflare: `wrangler deploy` for api, collab and web.

## Unknowns: test these before Phase 4

1. **Markdown conversion on Workers.** `@blocknote/server-util` pulls in jsdom, which
   crashes on workerd: it reads files when imported and uses `node:vm`. It's used only for
   collab (`collab.ts:103–120`: `toMarkdown`, `normalizeMarkdown`, `updateFrom`). The plan:
   - Try happy-dom or linkedom as the DOM for `ServerBlockNoteEditor`.
   - If neither works, Workers ship without `COLLAB_SECRET`. Documents still edit and
     save, just without live sync (`config.ts:66`).
2. **Startup time on the edge** for an 8.5 MiB bundle, against the 1 s limit. It started
   fine in local workerd.
3. **The git proxy** on workerd, with a large clone and push.
4. **better-auth's CPU per sign-in** under `limits.cpu_ms`.
5. **The boat SDK** with `fetchApi: fetch`.

## Keeping both working

- A lint rule (`no-restricted-imports`) forbids these outside
  `src/platform/node` and the entry files:
  - `node:fs`, `ws` and `@hono/node-server`;
  - `setInterval` at module level;
  - `import.meta.url`.
- CI builds the Worker for every change (`wrangler deploy --dry-run`). It also starts it
  in `wrangler dev` and checks `/health`, a sign-in and a hub connection.
- Tests keep running on Node.
- A new timer goes in `jobs`. Work after a response goes through `background()`. State
  that has to outlive a request goes in Postgres or the hub's `kv`, never in a module-level
  Map.

## Effort

| Phase                                 | Effort        | Ships                                                              |
| ------------------------------------- | ------------- | ------------------------------------------------------------------ |
| 1. VPS                                | 3–4 days      | VPS in production                                                  |
| 2. Portable groundwork                | about 1 week  | VPS, with jobs safe to run twice and state that survives a restart |
| 3. One hub per workspace              | about 2 weeks | VPS, behaving the same                                             |
| 4. API on Workers                     | 1–2 weeks     | Cloudflare (API)                                                   |
| 5. Dashboard and collab on Cloudflare | 2–3 days      | Cloudflare (everything)                                            |

That's 5–7 weeks in all, and the Markdown DOM question is the main risk. Phases 2 and 3
are worth doing even if Cloudflare never ships: they're also what running more than one
API process on the VPS would need.
