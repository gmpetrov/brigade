# Automations

Automations are work that starts without anyone typing a message. Triggers already
do this from events (`apps/api/src/triggers.ts`). This step adds **schedules**: a
teammate is prompted with the same instructions on a cron schedule. Each firing
starts a fresh thread.

The name is "schedule" because a **Task** already means an item on the Tasks board.

## Decisions

- **A new `Schedule` model.** A `Trigger` needs a connection and an event; a schedule
  has neither.
- **Cron plus a timezone.** The editor's presets write cron, so "Daily at 09:00" means
  09:00 in the schedule's timezone, DST included. The timezone defaults to the
  browser's. Runs are at least 5 minutes apart.
- **The owner's accounts.** A run uses the AI accounts of the member who created the
  schedule (`ownerMemberId`), the same way a trigger uses its creator's. Only the owner
  edits it. Admins may also pause or delete any schedule.
- **A run is an ordinary thread.**
  - The first message is the instructions, after one line saying which schedule
    this is, when it was due, and that nobody is watching live.
  - The origin is `schedule`.
  - It has the teammate's grants, policy, caps, memory and library.
- **The computer:** the workspace computer, or else the owner's own machine, the same
  choice `deliver()` makes.
- **No overlap.** A firing is skipped while the previous run's thread is still
  `running`, or `starting` for less than 15 minutes. A thread stuck in `starting` (its
  queued prompt lost in a restart) does not block the schedule for ever.
- **Missed firings collapse.** After downtime, a schedule runs once, not once per
  missed firing.
- **Never silent.** When a run cannot start, the owner gets a `question` ticket. Only
  one is open per schedule at a time, as for triggers.
- **History is the threads.** No separate table of runs: `Session.scheduleId` lists them.
- **Teammates create schedules too**, when someone asks in a thread for recurring work.
  - Only in a member's thread, never one started by a trigger or a schedule. An event
    cannot set up recurring work, and a schedule cannot multiply itself.
  - The owner is the thread's starter: they asked, and the runs spend their accounts.
  - A schedule a teammate creates is active immediately and is marked as made by that
    teammate. Its runs are still bounded by the teammate's grants, policy and caps.

## Data

```prisma
enum SessionOrigin { member trigger schedule }

model Schedule {
  id             String    @id @default(cuid())
  organizationId String
  workspaceId    String
  teammateId     String
  title          String
  instructions   String    // the first message of each run
  cron           String    // 5 fields
  timezone       String    // IANA, e.g. "Europe/Paris"
  ownerMemberId  String    // runs on this member's accounts
  createdByTeammateId String? // set when a teammate created it from a thread
  pausedAt       DateTime?
  nextRunAt      DateTime? // null while paused
  lastError      String?   // why the last firing could not start; cleared by the next start
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  sessions       Session[]

  @@index([nextRunAt])
  @@index([workspaceId])
}

// Session gains: scheduleId String? (Schedule, onDelete: SetNull), @@index([scheduleId, createdAt])
```

## Scheduler

`apps/api/src/schedules.ts` holds the scheduler. `watchSchedules()` is started from
`index.ts`, next to `watchSubscriptions()`.

**Tick.** Every 60 s, with a `ticking` guard against overlapping ticks. The first tick
waits for the next minute boundary, so a 07:00 run starts within a second or two of
07:00. Cron's resolution is a minute anyway.

1. Find schedules that are not paused and whose `nextRunAt` is at or before now.
2. For each one, move `nextRunAt` to the next firing after now, with
   `updateMany({ where: { id, nextRunAt: old } })`.
3. Call `fire()` only if that update changed a row.

The conditional update means a firing runs once, even with two instances.

**`fire()`** is also what Run now calls:

1. **Skip.** Do nothing if the teammate is archived, or the latest thread is still
   running (see No overlap).
2. **Start.** Call `startThread()` with the schedule's teammate, the computer, the
   owner, the instructions, and origin `{ kind: 'schedule', scheduleId }`. The thread's
   title is `"<title> · <date>"`.
3. **Failure.** On `offline`, or an `HTTPException` such as `noAccount`, set
   `lastError` and send the owner a ticket.

**Code to change:**

- `startThread()`'s `origin` becomes a union of the trigger and schedule cases.
- The audit actor is `system / schedule:<id>`.

Cron parsing and next runs come from [`croner`](https://github.com/hexagon/croner).
It goes in `@brigade/contracts`, so the API and the editor validate the same way.

## Agent tools

Three tools, built like `create_task`. Each is a tool in `harness/tools.ts`, sent from
the runner to the API as `schedule.call { callId, sessionId, teammateId, operation }`,
handled by `handleScheduleCall` in `schedules.ts`, and answered with `connector.result`.

- `create_schedule { title, instructions, cron, timezone? }`
  - Creates a schedule for the calling teammate, owned by the thread's starter.
  - Refused in a thread started by a trigger or a schedule.
  - If `timezone` is missing, it uses the owner's latest schedule, else UTC.
  - The result describes when it runs, in words, and gives the next 3 runs, so the
    teammate can confirm with the person in one line.
- `list_schedules {}`
  - Lists the schedules this teammate runs: title, when, next run, paused.
- `update_schedule { scheduleId, title?, instructions?, cron?, timezone?, paused? }`
  - Changes a schedule this teammate runs. Only from a thread whose starter owns it.
  - Deleting is left to people, on the Automations page.

In `instructions.ts`, a few lines on when to create a schedule:

- **Create one** when the person asks for something to happen repeatedly or at a later
  time ("every morning", "each Monday", "remind me on Friday").
- **Write the instructions so they stand alone.** Each run starts a fresh thread with no
  memory of this conversation, so they must name the inputs, the steps and where the
  output goes.

## API

| Route                        | What                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `GET /schedules`             | every schedule, with its teammate, owner, next run and latest thread |
| `POST /schedules`            | create; the creator is the owner                                     |
| `PATCH /schedules/:id`       | edit (owner only)                                                    |
| `POST /schedules/:id/pause`  | owner or admin                                                       |
| `POST /schedules/:id/resume` | computes `nextRunAt` from now                                        |
| `POST /schedules/:id/run`    | Run now; `nextRunAt` stays                                           |
| `DELETE /schedules/:id`      | owner or admin; its threads stay                                     |

Bodies are validated by `CreateSchedule` and `UpdateSchedule`: the cron expression,
the timezone and the 5-minute minimum.

## Dashboard

- **Sidebar.** **Automations** is added to `NAV`.
- **`/app/automations`.** A list of schedules. Each row has:
  - the title and teammate;
  - when it runs, in words, e.g. "Mondays at 07:00 (Paris)", from
    [`cronstrue`](https://github.com/bradymholt/cRonstrue);
  - the next run;
  - the last run, which links to its thread, or `lastError`;
  - an active switch;
  - Run now, Edit and Delete;
  - "by \<teammate\>" when a teammate created it.
- **New and Edit sheet.**
  - Fields: teammate, title, instructions.
  - **When:** hourly, daily at a time, weekdays at a time, weekly on a day at a time, or
    custom cron.
  - The timezone, and the next 3 runs, computed in the browser.
- **Thread page.** "started by schedule _\<title\>_ on \<owner\>'s accounts", linked to
  Automations.

## Build order

1. Schema and migration.
2. Contracts: inputs, cron helpers, and the `schedule.call` message.
3. API: `schedules.ts` (scheduler and `handleScheduleCall`) and `routes/schedules.ts`;
   the schedule case of `startThread()`'s `origin`.
4. Runner: the three tools and the lines in the instructions.
5. Dashboard: the page, the sheet and the thread label.

## Later

These are worth doing when someone asks for them:

- **Triggers on the Automations page**, and one run history for both kinds, with
  skipped and failed runs as rows (`AutomationRun`).
- **Behavior:**
  - "Notify me" for results: on Home, then email.
  - A `finish_run` tool, so the teammate can say "nothing to do".
  - Pause a schedule after repeated failures.
  - A time limit per run.
- **Options:**
  - A continue mode that reuses one thread, so each run sees the ones before it.
  - Overriding the model or the computer.
- **Templates** (a check-in or heartbeat, a daily digest), a week calendar, and
  duplicating a schedule.
