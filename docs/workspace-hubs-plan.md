# One hub per workspace: plan

Brigade's API on Cloudflare runs in a single Durable Object, `Api` (`apps/api/src/worker.ts`,
`src/api-object.ts`). Every workspace's HTTP requests, every runner's and dashboard's
WebSocket, and every timer in `src/jobs.ts` go through it. This plan moves to:

- **one hub Durable Object per workspace**, holding that workspace's sockets, using the
  WebSocket Hibernation API;
- **stateless HTTP** in Worker isolates;
- **Cloudflare Queues** for jobs and webhooks.

The goal is that one workspace can no longer take every other one down, and that load
spreads over many small objects instead of one.

Written on 2026-10-27, after the incident below. The Cloudflare limits quoted are from
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and the Queues JavaScript API docs, read the same day.

## Where it stands (2026-10-27)

All four phases are built, each off until it is turned on, so that a deploy changes nothing by
itself. What is left is turning them on, one at a time, with the checks below.

| Phase                    | Built                                                                                           | On with                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0. Safeguards and alerts | Outbox caps, reset and reconnect-storm alerts, hub sizes in the log, ops alerts start no thread | On at once                                   |
| 1. A hub per workspace   | `WorkspaceHub` and `hubs.get()`, in the API's process                                           | On at once: no change in behaviour           |
| 2. Hub objects           | `WorkspaceHubObject`, routing in the front, runner protocol 46                                  | `POST /ops/hubs`, per workspace              |
| 3. Jobs on Queues        | A job per workspace, the cron's messages, the consumer                                          | `JOBS_ON_QUEUE` in `wrangler.jsonc`          |
| 4. Stateless HTTP        | Reads in brigade-api's own isolates, placed next to the database                                | `STATELESS_ROUTES` in `wrangler.front.jsonc` |

### How it works now

- **One hub per workspace.** `apps/api/src/hub/workspace-hub.ts` holds one workspace's sockets
  and what waits on them: commands queued for a computer starting, requests waiting on a
  runner's answer, sign-ins, calls held for a person, timers. Code outside a hub reaches it
  only through `hubs.get(workspaceId)` (`src/hub.ts`). Its operations (`src/hub/operations.ts`)
  are async and copyable, and run in the hub wherever it lives.
- **No hub state in modules.** A module keeps a workspace's state with its hub
  (`currentHub().local()`, `perHub()`). `currentHub()` throws outside a hub, so code that
  bypasses `hubs.get()` fails in tests rather than in an object later. `test/hub-state.test.ts`
  fails on a module-level Map, Set or array that is not on its list, with why.
- **Where a hub lives.** On Node, and in the Api object, a hub lives in memory
  (`src/hub/memory-host.ts`). A workspace whose `hubMode` is `object` has its own
  `WorkspaceHubObject` (`src/hub-object.ts`), named by its id:
  - Sockets are accepted with the Hibernation API. Each connection's state is its attachment.
    What must outlive the object's memory (restarts, waiting threads, sign-ins, held calls'
    waiters, small queued commands) is in its own storage. Its timers are one alarm, or memory
    for those under 10 seconds.
  - Runners and dashboards send `{"type":"keepalive"}` every 30 s. The runtime answers it without
    waking the object (`setWebSocketAutoResponse`), and the object reads when it last did
    (`getWebSocketAutoResponseTimestamp`) to tell a silent runner.
  - Each object has its own Prisma client, as objects may share an isolate. It keeps three
    connections at most and lets them go after 5 s idle, so that it can hibernate. With
    `DB_HYPERDRIVE` bound, it connects through Hyperdrive.
  - Its failures are counted in the Api object, where the checks run.
- **Routing.** A socket names its workspace: a runner's `?workspace=` (from its welcome,
  protocol 46) or its token (`<workspaceId>.<secret>` for links from now on), a dashboard's
  `?workspace=`. The front Worker (`src/front.ts`) sends it to the Api object first, which
  passes on those of workspaces whose hub has its own object; with `HUB_ROUTING` set to
  `"hubs"` in `wrangler.front.jsonc`, to the workspace's hub object first, so that an Api object
  down does not keep them from connecting. The object that does not hold a workspace's sockets
  answers 421 with `x-brigade-hub` and `x-brigade-workspace`, and the front sends the socket
  there. Each front isolate remembers where a workspace's sockets went for 30 s. A hub object
  holds its workspace's hub from the moment it moved there, as its own storage says: until then
  it answers 421 at once, and keeps nothing.
- **Calls between objects.** In the Api object, `hubs.get()` runs a hub that is its own, and
  calls a hub object by RPC. In a hub object, it runs its own hub, and calls the others' object
  or the Api object. An object that gets a call for a hub it no longer holds passes it on once.
- **Jobs** (`src/jobs.ts`). Each job says which workspaces have work due and runs for one of
  them; the sweeps and a few others run once for all. On Node, and in the Api object while
  `JOBS_ON_QUEUE` is `"0"`, timers run them as before. With `"1"`, the cron puts one message per
  workspace and job on `brigade-jobs` each minute; the consumer runs each alone, retries it 5
  times, then dead-letters it to `brigade-jobs-dlq`. The Api object then runs no timers: the
  cron's minute ping runs its checks and ticks its own hubs. Webhooks' events and received mail
  go on the queue too.
- **Stateless reads.** A GET under a path of the front's `STATELESS_ROUTES` runs in brigade-api's
  own isolates (`x-brigade-ran: isolate`), with a client per request, and reaches hubs by RPC.
  brigade-api is placed in `aws:eu-central-1`, for these, the cron and the consumer.

### Rolling out

Before the deploy that brings it:

1. Create the queues, which `wrangler.jsonc` binds: a deploy fails without them.
   `pnpm --filter @brigade/api exec wrangler queues create brigade-jobs` and
   `... wrangler queues create brigade-jobs-dlq`.
2. Optionally, create Hyperdrive with its cache off and bind it as `DB_HYPERDRIVE` in
   `wrangler.jsonc`: `wrangler hyperdrive create brigade-objects
--connection-string=<DATABASE_URL> --caching-disabled`. Hub objects, the cron, the consumer
   and stateless reads connect each time they wake or run; without it, each connection is a
   new TLS handshake to Neon. Needed before stateless reads.

Then, each step on its own, watching the alerts and the logs:

1. **Hub objects, one workspace at a time.** `POST https://api.brigade.lol/ops/hubs` with
   `Authorization: Bearer <OPS_TOKEN>` and `{"workspaceId": "...", "mode": "object"}`. The
   workspace's sockets close in the Api object (1012) and connect again to its object, through
   the Api object. Back with `"mode": "api"`. Start with Brigade's own workspace. Each time the
   object wakes, brigade-api's logs say `hub <id>: woke with N sockets`. Once several
   workspaces have moved, set `HUB_ROUTING` to `"hubs"` in `wrangler.front.jsonc`: their
   sockets then connect without the Api object, even while it is down, which is the isolation
   this plan is for.
   Done on 2026-10-27: every workspace's hub has its own object, and `HUB_ROUTING` is `"hubs"`.
   A workspace made since gets its object as it is created, from the Api object, next to the
   database (`placeNewHub`): before, its first socket made it from the front, wherever that
   socket came in, and an object never moves. Should that fail, it stays in the Api object until
   it is moved.
2. **Jobs on the queue.** Set `JOBS_ON_QUEUE` to `"1"` in `wrangler.jsonc`, and deploy. Watch the
   queue in the dashboard, and the `jobs:dead` and `jobs:late` alerts. Back with `"0"`. Done on
   2026-10-27.
3. **Stateless reads.** Once Hyperdrive is bound, set `STATELESS_ROUTES` to
   `/api/threads,/api/inbox,/api/tasks,/api/projects`. Compare the `Server-Timing` of
   responses with `x-brigade-ran: isolate` with the Api object's, from far away (Los Angeles)
   and near, before adding more.

What was checked: the API's tests on Node (592), with operations' arguments copied as between
objects (`HUB_COPY=1`); and under `wrangler dev` (local workerd and PostgreSQL): a workspace
moved to its object and back; runners with and without a workspace in their token or query;
a broadcast and a sign-in crossing objects; a hub object that hibernated for 40 s with
keepalives only and woke with its two sockets; the cron queuing a workspace's due wake-up
and the consumer firing it; stateless reads. Not checked, as there is no staging environment:
real runners on boat, eviction under load, a 50-command backlog of 1 MB commands, Hyperdrive,
placement, and latency from far away.

## Why: the incident of 2026-10-27

- A workspace's cloud computer stayed down for hours. Meanwhile 53 `thread.prompt`
  commands were kept for it (`RunnerCommand`), 54 MB of JSON in all, because each carried
  its thread's whole spec.
- When its replacement's runner connected, `flushQueue` read all 53 commands in one query.
  The `Api` object went past its memory and was reset, with no error in the logs.
- The reset dropped every socket of every workspace, runners and dashboards alike. Each
  runner reconnected, which reset the object again, every 2 to 5 seconds for over an hour.

The triggers are fixed (`68bc6f3f`, `c7fa7260`, `1b436caf`, `2ad3fadf`): commands are read
one at a time, a spec's large parts travel by hash, and stale kept commands no longer go.
What is not fixed is the fragility: any oversized payload, loop or slow handler in one
workspace still stops every workspace.

## What the Cloudflare docs say, applied to Brigade

| Fact from the docs                                                                                                                      | What it means here                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Each object is single-threaded, with a soft limit of about 1,000 requests per second; past it, requests queue, then fail as overloaded. | All of Brigade shares one such budget today: every HTTP request, every WebSocket message, every job.                                      |
| CPU is limited to 30 s per invocation by default (up to 5 min with `limits.cpu_ms`), and each WebSocket message is an invocation.       | A slow handler (large JSON, a big Prisma read) holds every other workspace's messages back while it runs.                                 |
| Memory is the Workers isolate limit; the Durable Objects limits page does not state it.                                                 | Today's reset came from exceeding it, and nothing logged it.                                                                              |
| The number of objects is unlimited.                                                                                                     | The intended shape is many small objects, not one large one.                                                                              |
| With `ctx.acceptWebSocket()` (Hibernation), an idle object is evicted while its clients stay connected, and its duration is not billed. | This is what makes one object per workspace cheap: most workspaces are idle most of the time.                                             |
| On wake, the constructor runs again and in-memory state is gone; `serializeAttachment` keeps up to 16 KB per socket.                    | Per-connection state (runner id, computer, protocol, bundle) goes in the attachment. Everything else must be rebuilt from storage.        |
| Alarms, incoming requests, `setTimeout` and `setInterval` keep an object awake.                                                         | The timers in `src/jobs.ts`, `watchRunners`, `offerRunnerUpdates` and `pingBrowsers` all run in the `Api` object, so it never hibernates. |
| WebSocket ping frames get an automatic pong without waking the object.                                                                  | Our runner also sends an application `heartbeat` message every 30 s, which wakes it. Hibernation needs that to change.                    |
| Many small messages cost more than fewer, larger ones; batch them.                                                                      | The runner already batches events (`eventBatches`).                                                                                       |
| A deploy restarts every Durable Object and disconnects every WebSocket.                                                                 | Unchanged by this plan; runners and dashboards already reconnect.                                                                         |
| A Queues message is at most 128 KB, and delivery order within a batch is best effort.                                                   | Queues cannot carry runner commands, which can be large and must keep their order. The Postgres outbox (`RunnerCommand`) stays.           |

## Where we were (before this work)

- **The `Api` object** runs the Hono app, the hub and the jobs, with one Prisma client and
  its pool. The front Worker (`src/front.ts`) forwards every request to it.
- **`src/hub.ts`** is about 2,000 lines. It holds about 15 module-level maps and sets:
  - `runners` and `browsers`: the connections;
  - `restarting`: runners mid-update;
  - `queued`: commands without an id, waiting for a runner;
  - `eventsWaiting`: threads whose events wait on their runner;
  - `terminals`, `clipboards`, `fileReads`, `fileWrites`, `sourceFinds`, `codeReads`:
    requests waiting on a runner's answer;
  - `libraryTimers`, `listTimers`: debounced broadcasts;
  - `lastLooked`, `noteFailures`.
- **`src/cloud.ts`** holds about 11 more: `lastActive`, `provisioning`, `bringing`,
  `keptAlive`, `stoppingIdle`, `homesGivenBack` and others.
- **44 modules import the hub.** About 20 broadcast to dashboards, and about 25 reach
  runners (`dispatch`, `sendToRunner`, `isOnline`, `runnerProtocol`).
- **`src/jobs.ts`** starts:
  - 11 watchers: subscriptions, merges, notifications, schedules, wake-ups, idle computers,
    runner updates, browser pings, silent runners, mail, ops;
  - a minute's work: held calls, command resends, inbound events, replacements;
  - GitHub redelivery;
  - a sweep of about 10 tables.

  Most of these loop over every workspace.

- **The VPS deployment** runs the same code in one Node process
  (`deployment-plan.md`). It must keep working: every change below goes behind a seam,
  with a Node implementation that keeps everything in one process.

## Target

```
browser / runner
      │  wss  (workspace in the token or the URL)
      ▼
front Worker ──────────────► Hub DO (one per workspace, Hibernation)
      │  HTTP                    · sockets of that workspace's runners and dashboards
      ▼                          · per-socket state in attachments
API Worker isolates              · timers as one alarm
(stateless, Prisma via           · reached by RPC: broadcast, dispatch, isOnline …
 Hyperdrive, placed near DB) ──► Postgres (Neon, Frankfurt): source of truth,
      │                          RunnerCommand outbox, events
      ▼
Queues ◄── cron Worker (enqueues per workspace), webhooks
      │
      ▼
consumer Workers (jobs, triggers, mail) ── RPC to the Hub DO only to reach a socket
```

On the VPS, the same `WorkspaceHub` class runs in-process: a `Map<workspaceId,
WorkspaceHub>`. Jobs keep running on timers, and a "queue" is a function call.

## Phases

Each phase ships on its own, keeps the VPS working, and can be rolled back.

### Phase 0: safeguards and alerts (2–3 days)

Done on 2026-10-27:

- payloads are bounded: pending commands are read one at a time, and spec parts travel by
  hash;
- stale kept commands are expired or brought up to date.

Done on 2026-10-29:

- an App's tools leave thread specs (`src/catalogs.ts`, CATALOG_PROTOCOL): each connector
  names its App's catalog by a version, and the runner fetches it once from the API Worker's
  own isolates (`GET /runner/catalogs/<connectionId>`). A hub builds specs at each message,
  reconnect (one per running thread) and child report; with an MCP App's tools in them (PostHog's
  came to 2.7 MB), it went past the 128 MB of its isolate, which several hub objects may share,
  and dropped every socket. A catalog past 2 M characters is reported (`catalog-size`), past 8 M
  its last tools are left out.
- (2026-10-30) a catalog writes each subschema a tool's input schema repeats once, under
  `$defs`, and a `$ref` where it was (`sharedSubschemas` in `@brigade/contracts`): PostHog's went
  from 2.6 M characters to 1.6 M. The API keeps catalogs so and sends them so to a runner that
  asks (`?schemas=shared`); the runner writes each schema out whole again
  (`unsharedSubschemas`) before its harness gets it, since Claude Code's bridge turns schemas
  into zod and reads a `$ref` as any value. A runner that does not ask gets them whole.

To do:

1. **Alert on resets.** Alert when the `Api` object restarts outside a deploy: the cron's
   `ping()` already returns `upForMs`, so alert when it drops under a minute with no new
   script version.
2. **Alert on reconnect storms.** Alert when one computer opens more than N
   `/runner/ws` per minute, counted in the hub, then `noteFailure`.
3. **Cap the outbox.** Cap pending commands per computer and per thread. Collapse a
   trigger's deliveries to a stopped computer into the latest one, and stop delivering
   ops-alert mail (`Auto-Submitted`) to triggers.
4. **Log what the object holds.** Log the hub's in-memory sizes (connections, queued,
   waiting maps) every minute, to see growth before it costs a reset.

**Done when:** an incident like 2026-10-27 alerts within minutes.

### Phase 1: a hub interface per workspace, still in one object (about 1 week)

This is a pure refactor with no change in behaviour or deployment. It is the step that
makes the rest mechanical.

1. **A `WorkspaceHub` class.** Move the per-workspace state of `hub.ts` and `cloud.ts` into
   it: connections, `restarting`, `queued`, `eventsWaiting`, pending reads, terminals,
   debounce timers, `lastActive`, `keptAlive` and the rest.
2. **A `hubs` interface.** `hubs.get(workspaceId)` returns that workspace's hub, with
   **async** methods only:
   - `broadcast`, `notifyList`;
   - `dispatch`, `sendToRunner`;
   - `isOnline`, `runnerProtocol`, `connectedBundle`;
   - `readThreadFile` and the other runner requests;
   - `openTerminal`, `wake`.

   Today it is a `Map` in the one object. Async now means the later switch to RPC changes
   no caller.

3. **Rewrite the 44 importing modules** to go through `hubs.get(scope.workspaceId)`. A
   call that has no workspace is a smell worth fixing here. Examples:
   - `watchRunners` loops over every runner;
   - `offerRunnerUpdates` and `enforcePlans` loop over every computer.

   Each becomes a per-hub method called from a loop over the workspaces that have
   connections.

4. **Write cross-hub reads as queries,** not by reading another hub's maps. For example,
   "is this computer online" for a computer of another workspace should never be asked.
5. **Lint:** forbid module-level `Map`/`Set` holding per-workspace state outside
   `WorkspaceHub`.

**Done when:** the tests pass, nothing changes in production, and `hub.ts` exports only the
`hubs` interface, the socket entry points and pure helpers.

**Risk:** a large diff in hot code. Do it in a few PRs: connections and broadcast first,
then runner requests, then cloud.ts state.

### Phase 2: Hub Durable Objects with Hibernation (1.5–2 weeks)

1. **New class `WorkspaceHubObject`** in `wrangler.jsonc`, SQLite-backed, with a new
   migration tag. It wraps `WorkspaceHub` and is named `idFromName(workspaceId)`. Its
   location hint is `weur` or placed like `Api`: it queries Postgres in Frankfurt.
2. **Route sockets by workspace in the front Worker.**
   - **Runners:** new tokens carry their workspace (`<workspaceId>.<secret>`). An old
     token is looked up once through the `Api` object, which answers its workspace. The
     hub object checks the token itself, against Postgres, and that it belongs to its own
     workspace.
   - **Dashboards:** `/api/ws?workspace=<id>`. The hub object checks the session, and that
     the member belongs to that workspace.
3. **Hibernation:**
   - Accept with `ctx.acceptWebSocket(server, [tag])`, tagged `runner:<computerId>` or
     `browser:<memberId>`. Find connections with `ctx.getWebSockets(tag)` instead of the
     `runners` and `browsers` maps.
   - Each socket's attachment holds `runnerId`, `computerId`, `protocolVersion`, `bundle`,
     `offered` and `startedAt` for a runner; `memberId` and `looking` for a browser. All
     are well under 16 KB.
   - **Liveness without waking:**
     - make the runner's 30 s application `heartbeat` optional from a new protocol
       version; the runner's ws `ping()` already keeps the connection alive;
     - the hub decides a runner is silent from the runtime's last auto-response time,
       not from `heardAt` set in a message handler. This API is to be confirmed in the
       docs.
   - **No `setTimeout` or `setInterval`.** Each object has a single alarm: a small table
     in the object's SQLite storage lists the next due times (restart timeouts, debounced
     broadcasts, idle checks), and the alarm runs those due, then sets itself to the next.
   - State that must survive eviction moves to the object's storage or to Postgres:
     - `restarting`;
     - the non-durable `queued` commands, or make them durable;
     - `eventsWaiting`.

     Requests waiting on a runner's answer (file reads, terminals, clipboards) keep the
     object awake while they wait, so they can stay in memory.
4. **The `Api` object stops holding sockets.** Its code calls `hubs.get(id)`, which is now
   an RPC stub to the workspace's hub object.
5. **Postgres connections.** Today one object holds one pool. With many hub objects awake
   at once, direct connections could exceed Neon's limit. Hub objects connect through
   **Hyperdrive with caching off**: Hyperdrive's cache serves reads older than the latest
   writes, which the hub cannot accept. Measure query latency from a hub object next to
   Frankfurt: a hub handler makes several queries per runner message.
6. **Rollout per workspace.** A flag on the workspace (`hubMode: 'api' | 'object'`), read
   by the front Worker. Start with an internal workspace, then a few, then all. Rolling
   back means flipping the flag: the next reconnect lands on the `Api` object again.

**Done when:** a workspace's sockets live in its own object; resetting one hub object,
deliberately in staging, drops only that workspace's sockets; an idle workspace's object
hibernates; and the 2026-10-27 scenario replayed in staging affects one workspace.

**Risks:**

- **Wake cost.** Waking a hibernated object runs its constructor and loads the Worker,
  which is 13 MB with Prisma. Measure the first message's latency after a wake, and keep
  the constructor empty.
- **Cross-object calls.** Each broadcast from HTTP code becomes an RPC. Batch per request
  where a handler broadcasts several times, and never await a broadcast inside a
  transaction.
- **Two sources of truth during the rollout.** A workspace's runner on the `Api` object
  and its dashboard on its hub object would not see each other's broadcasts. The flag is
  per workspace and the front Worker routes both sockets of a workspace the same way.
  Switching the flag closes the workspace's open sockets on the old side.
- **Liveness without heartbeats** is unproven here. Keep the application heartbeat for
  runners below the new protocol, and accept that their objects do not hibernate.

### Phase 3: jobs and webhooks on Queues (about 1 week)

1. **The cron Worker stops pinging the `Api` object to run jobs.** Each minute it reads
   which workspaces have due work, with cheap indexed queries, and enqueues one message
   per workspace and job: `{ job: 'resend-commands', workspaceId }`. Messages stay well
   under 128 KB: ids only, never payloads.
2. **Consumer Workers run the job's existing function, scoped to one workspace.** A
   consumer reaches the workspace's hub object by RPC only to touch a socket. Set
   `max_concurrency`, `max_retries` and a dead-letter queue, and alert on the dead-letter
   queue's backlog through `metrics()`.
3. **Webhooks** (`/events/gmail`, `/events/resend`, `/github/webhook`, Stripe) verify their
   signature, keep the event as a row (as `inbound.ts` already does), enqueue its id and
   answer at once.
4. **Timers that belong to one workspace's sockets** become its hub object's alarm:
   - idle stop of its cloud computer;
   - runner update offers;
   - silent-runner checks.
5. **Jobs stay idempotent,** as Phase 2 of `deployment-plan.md` already made them: a
   message delivered twice does no harm.
6. **VPS:** the same job functions keep running on the Node timers; `enqueue` calls them
   directly.

**Done when:** the `Api` object runs no timers, and a job failing for one workspace retries
alone and lands in the dead-letter queue without delaying the others.

**Risks:**

- Ordering between jobs of one workspace is not guaranteed. Today's jobs already tolerate
  running in any order and twice; check the few that assume a previous tick ran
  (`driveReplacements`, `giveUp`).
- More moving parts to watch: queue backlog, dead-letter queue, consumer errors. Add them
  to `watchOps`.

### Phase 4: stateless HTTP (1–2 weeks, route by route)

1. **Routes run in Worker isolates.** `/api/*` and `/runner/*` HTTP routes run directly in
   a Worker with a Prisma client per request through Hyperdrive, caching off, instead of
   being forwarded to the `Api` object. Start with read-heavy routes: threads, inbox,
   tasks, projects.
2. **Placement.** A request makes about ten queries. From an isolate near a user in Los
   Angeles to Neon in Frankfurt, that is ten transatlantic round trips. Place the API
   Worker next to the database (`placement` with region `aws:eu-central-1`, or Smart
   Placement) and measure p50 and p95 against today's numbers before moving more routes.
3. **What still needs the hub** (broadcast after a write, dispatch to a runner) calls the
   workspace's hub object by RPC.
4. **Long requests stay where they work today until moved deliberately:**
   - the git proxy;
   - desktop relays;
   - uploads, capped at 100 MB per request on our plan.
5. **The `Api` object ends up holding nothing.** Remove it once no route forwards to it.

**Done when:** most HTTP traffic no longer goes through a single object, and latency is
within today's numbers.

**Risks:**

- Latency, if placement is wrong.
- Hyperdrive behaviour under load.
- Prisma cold starts per isolate: the 13 MB Worker is the reason the front Worker exists.
  Measure the first request on a fresh isolate.

## Risks overall

| Risk                                                                            | Mitigation                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A large refactor of hot code breaks runners or dashboards.                      | Phase 1 changes no behaviour and ships first; tests on Node; staging with real runners; per-workspace flag in Phase 2.                   |
| Too many Postgres connections from many objects and isolates.                   | Hyperdrive (cache off) everywhere but the VPS; watch Neon's connection count.                                                            |
| Latency grows with cross-object RPC and wake-ups.                               | Measure each phase against a baseline taken in Phase 0; batch broadcasts; keep the constructor empty.                                    |
| Hibernation does not happen (something keeps objects awake).                    | Count awake hub objects in metrics; no timers in hub objects, alarms only; runner liveness through ping frames.                          |
| One very large workspace outgrows one object (about 1,000 requests per second). | Not expected soon. If it comes, split runner sockets per computer (`idFromName(computerId)`) and keep a workspace object for dashboards. |
| The VPS drifts from Cloudflare.                                                 | Same `WorkspaceHub` class on both; the seams stay in `src/platform/*`; CI builds both.                                                   |
| A deploy still drops every socket.                                              | Unchanged by design; runners and dashboards reconnect, and the outbox resends.                                                           |

## Testing

- **Unit and integration tests on Node,** as today. `WorkspaceHub` tests run against its
  in-process implementation.
- **A staging Cloudflare environment,** with real runners on boat sandboxes, for each
  phase:
  - reset one hub object and check that only its workspace reconnects;
  - replay a 50-command backlog of 1 MB commands;
  - hibernate, then wake on a runner message;
  - flip a workspace's flag back and forth.
- **A load test before Phase 4:** many workspaces with a runner each sending events, and
  dashboards open, measuring per-message latency and Postgres connections.

## Effort

| Phase                                   | Estimate     |
| --------------------------------------- | ------------ |
| 0. Safeguards and alerts                | 2–3 days     |
| 1. Hub interface per workspace          | about 1 week |
| 2. Hub Durable Objects with Hibernation | 1.5–2 weeks  |
| 3. Jobs and webhooks on Queues          | about 1 week |
| 4. Stateless HTTP                       | 1–2 weeks    |

These are rough estimates for one person, about 5 to 7 weeks in all. Phases 0 to 2 bring
the isolation that matters most. Phases 3 and 4 bring throughput, and can wait for load.

## Open questions

Answered while building it:

- Liveness without waking: a text keepalive the runtime answers itself (`KEEPALIVE`), and
  `getWebSocketAutoResponseTimestamp` says when it last answered one. Runners keep sending ping
  frames too, to tell a dead connection on their side.
- `AsyncLocalStorage` carries through `setTimeout`, `setInterval` and promises in workerd: each
  object's client and hub follow its code through its timers.

Still open:

1. How a hub object should check a runner's liveness without application messages: the
   API that exposes the last auto-response time, and whether it covers ping frames sent by
   the client.
2. Hyperdrive with caching off: per-query latency from an object placed next to Neon,
   compared to today's direct pool (2–3 ms per query).
3. Whether to give each computer its own object for runner sockets from the start, which
   isolates one bad computer even within a workspace, at the cost of more RPC between a
   workspace's dashboards and its computers.
4. Neon's connection limit on our plan, and whether Neon's pooler or Hyperdrive should
   front it.
