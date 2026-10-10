# Tasks

Every message starts a **thread**: a conversation with a teammate. Bigger work
becomes a **task**: something you want to see finished, with a teammate, a
priority, a description and a place on the Tasks board.

## Decisions

- **One thread per task.** A task's thread is its comments and its progress
  trail; there is no separate comment or event system. The link lives on the
  thread (`Session.taskId @unique`), so several threads per task later only
  means dropping `@unique`.
- **One teammate per task**, reassignable.
- **The agent may mark a task done.** A message to a done task's thread
  reopens it.
- **No tasks from triggers.** A thread a trigger started cannot become a task.
- **Passive backlog.** Nothing picks up Backlog work by itself; a person starts it.

## Columns

The column is derived, never stored:

| Column    | Rule                                                       |
| --------- | ---------------------------------------------------------- |
| Backlog   | no thread yet                                              |
| Needs you | has a thread with an open ticket, or the thread is waiting |
| Doing     | has a thread and is not done                               |
| Done      | `completedAt` is set                                       |

## Data

```prisma
enum TaskPriority { low medium high urgent }

model Task {
  id                String
  organizationId    String
  workspaceId       String
  title             String
  description       String       @default("")
  priority          TaskPriority @default(medium)
  teammateId        String       // who does it
  createdByMemberId String       // who asked; a thread's starter when the agent creates it
  summary           String?      // what was done, from complete_task
  deliverables      Json         @default("[]") // [{ label, url }]
  completedAt       DateTime?
  session           Session?     // Session.taskId @unique
}
```

## Agent tools

Both harnesses get two tools; the API checks every call.

- `create_task { title, description, priority? }`: the current thread becomes
  the task's thread. Refused in a trigger's thread or one that is already a task.
- `complete_task { summary, deliverables? }`: marks the thread's task done, with
  what was done and links to it (PR, document).

When to create a task is in the tool description and the session instructions:
when the work has a deliverable someone will review, takes several steps, will
wait on someone, or the user asks to track it. Not for questions, explanations
or quick actions finished in the same reply. Create it before starting the work,
or as soon as a conversation turns into work. Do not ask first.

A thread that is a task says so in the session instructions (title and
description), so the teammate knows to call `complete_task`.

Runner → API: `task.call { callId, sessionId, teammateId, operation }`, answered
with `connector.result`, like `library.call`.

## API

| Route                      | What                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `GET /tasks`               | the board: every task with its column, teammate, thread status, open ticket count   |
| `GET /tasks/:id`           | one task, with its thread's pull requests                                           |
| `POST /tasks`              | create by hand (Backlog), or from a thread with `sessionId` ("Make this a task")    |
| `PATCH /tasks/:id`         | title, description, priority                                                        |
| `POST /tasks/:id/start`    | `{ computerId, accountId? }`: starts its thread with the brief as the first message |
| `POST /tasks/:id/reassign` | `{ teammateId, reason }`                                                            |
| `POST /tasks/:id/complete` | a person marks it done                                                              |
| `POST /tasks/:id/reopen`   | back to Doing (or Backlog without a thread)                                         |
| `DELETE /tasks/:id`        | the task goes; its thread stays a plain thread (also the "undo" of `create_task`)   |

Changes broadcast `task.updated` to dashboards.

### Reassign

- No thread yet: only the teammate changes.
- With a thread: the new teammate needs a usable account for the thread
  starter's harness on that computer (else 409, and the picker greys it out).
  A running turn is interrupted. The new teammate joins the thread and is
  prompted with a message the API writes: the task's title and description,
  the reason, the deliverables so far (pull requests from the thread, the
  previous summary) and a note that the previous teammate's files are not in
  its folder. A done task reopens.

Teammates do not share working folders, so deliverables must live somewhere
shared (a pushed branch or PR, a thread attachment, the library). The task
instructions say so.

## Dashboard

- **Tasks** in the sidebar, with the Needs-you count as its badge.
- `/app/tasks`: the board, four columns. A card shows title, priority,
  teammate and thread status. Clicking it opens a side sheet: details, edit,
  Start (backlog), Reassign, Mark done / Reopen, Delete, Open thread.
- **New task** dialog: title, description, priority, teammate.
- Thread page: a task bar when the thread is a task (title, column, Reassign,
  Mark done, Not a task); **Make this a task** otherwise.

## Build order

1. Schema and migration.
2. Contracts: inputs, `ThreadSpec.task`, `task.call`, `task.updated`.
3. API: `tasks.ts` (logic, runner calls), `routes/tasks.ts`, thread routes (task
   on the thread, reopen on message).
4. Runner: the two tools, instructions, plumbing.
5. Dashboard: board, sheet, dialogs, thread task bar.

## Later

- Several threads per task ("Start over" in a fresh thread).
- Several teammates per task.
- A backlog teammates pick work from, ordered by priority.
- Tasks from triggers.
- Measuring `create_task` undo and "Make this a task" rates to tune when agents create tasks.
