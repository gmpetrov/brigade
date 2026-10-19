# Tasks

Every message starts a **thread**: a conversation with a teammate. Bigger work
becomes a **task**: something you want to see finished, with a priority, a
description, a place on the Tasks board and, once someone is on it, a teammate.

## Decisions

- **One thread per task.** A task's thread is its comments and its progress
  trail; there is no separate comment or event system. The link lives on the
  thread (`Session.taskId @unique`), so several threads per task later only
  means dropping `@unique`.
- **One teammate per task**, reassignable. Teammates only: a task is never
  assigned to a person.
- **Assigning starts it.** A task created with nobody assigned waits in
  Backlog. Assigning a teammate starts its thread at once, with the brief as
  the first message; there is no Start button. So a task has a teammate exactly
  when it has a thread (the task's own column says Backlog otherwise).
- **Agents manage the board.** They create, comment on, update, assign, move
  (Doing, Archive, Trash) and complete tasks. They never assign a person and
  never move a task to Needs you: when an agent needs someone, it opens a
  ticket, and the task moves to Needs you.
- **A message to a done task's thread reopens it.**
- **No tasks from triggers.** A thread a trigger started cannot become a task.
- **Trash, not delete.** Moving a task to the Trash takes it off the board from
  any column and stops its running turn; restoring brings it back. Deleting
  for good stays (from the Trash, or "Not a task" on its thread).
- **Done goes away by itself.** A task done for 3 days is archived by the API's
  hourly sweep (`sweepDoneTasks`); "Archive all" clears Done sooner.
- **One goal, one task, cut in deliveries.** A person's attention is what is
  scarce: a goal of days or several pull requests is one task, planned in one
  to three deliveries, each a moment where the person tries something that works
  or decides something only they can. Never one task per technical step: a
  mission of nine tasks made a person follow nine pull requests. Its parts stay
  off the board: the teammate does them itself (Claude Code's sub-agents for
  parallel or side work), and starts a child thread only for what must outlive
  its turn, is for another teammate (such as the review before a delivery) or may
  need a person. A goal that came up in a conversation about something else gets
  a thread of its own: the teammate assigns the task to itself by name. The
  rules are in the session instructions (`bigGoals` in apps/runner/src/instructions.ts).
- **Missions group tasks toward one goal, rarely.** A mission is a task with
  sub-tasks (`Task.parentId`, one level), "Mission" in visible text only. The
  board shows it as one card ("Mission", its title, `done/total`); its sheet
  lists its tasks. A sub-task is in its mission's project. Teammates make one
  only when several teammates each own a delivery the person follows on its
  own: the mission first (titled without the word "Mission"), then each task
  with `mission`.

## Missions

- **Column**, computed on the board from the mission and its tasks: Needs you
  while it or any of its tasks waits on a person; Done once it is done; Backlog
  while it has no thread and every task is in Backlog; else Doing. Each task
  keeps its own column in the API, so the sidebar, Home and notifications count
  the real items, never the mission on top.
- **Done by itself**: the API marks a mission done when its last task is done,
  and reopens it (with its archived tasks) when one is reopened or added.
- **Archive and Trash**: archiving a mission archives its tasks with it; a task
  in a mission is not archived alone, and unarchiving it brings its mission
  back. Trashing a mission takes its unfinished tasks with it, at the same
  time, and restoring brings those back. Deleting a mission for good leaves its
  tasks as tasks of their own.

## Columns

The column is derived, never stored:

| Column    | Rule                                                       |
| --------- | ---------------------------------------------------------- |
| Backlog   | no thread yet (nobody assigned)                            |
| Needs you | has a thread with an open ticket, or the thread is waiting |
| Doing     | has a thread and is not done                               |
| Done      | `completedAt` is set                                       |

Archived (`archivedAt`) and trashed (`trashedAt`) tasks are off the board.

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
  teammateId        String?      // who does it; unset in Backlog
  createdByMemberId String       // who asked; a thread's starter when the agent creates it
  summary           String?      // what was done, from complete_task
  deliverables      Json         @default("[]") // [{ label, url }]
  completedAt       DateTime?
  archivedAt        DateTime?
  trashedAt         DateTime?
  session           Session?     // Session.taskId @unique
}
```

## Agent tools

Both harnesses get these tools; the API checks every call. A teammate acts for
its thread's starter: a thread it starts runs on that member's accounts, on its
own thread's computer.

- `create_task { title, description, priority?, assignee?, mission? }`: `mission`
  puts it in that mission (refused for a sub-task, an archived or trashed one);
  `assignee` is
  `self` (default: the current thread becomes the task's thread; refused in a
  trigger's thread or one that is already a task), `none` (Backlog), or a
  teammate id or name (a new task, its thread started for that teammate).
- `list_tasks`: the board's tasks with ids (a sub-task's `missionId`, a mission's `mission: { done, total }`), and the teammates.
- `comment_on_task { taskId, text }`: a message in that task's thread, headed
  with who wrote it; its teammate answers there. Not for Backlog tasks.
- `update_task { taskId, title?, description?, priority?, mission? }`: `mission`
  moves it into a mission, or `"none"` out of its mission.
- `assign_task { taskId, teammate, reason? }`: teammates only. Backlog: starts
  it. Started: a reassign (below).
- `move_task { taskId, to: doing | archived | trash }`: `doing` reopens a done,
  archived or trashed task.
- `complete_task { taskId?, summary, deliverables? }`: this thread's task by
  default.

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

| Route                      | What                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| `GET /tasks`               | the board: every task with its column, teammate, thread status, open ticket count |
| `GET /tasks?archived=true` | archived tasks, a page at a time; `?trashed=true`: the Trash                      |
| `GET /tasks/:id`           | one task, with its thread's pull requests                                         |
| `POST /tasks`              | create: Backlog, or started with `teammateId`; or from a thread with `sessionId`  |
| `PATCH /tasks/:id`         | title, description, priority                                                      |
| `POST /tasks/:id/assign`   | `{ teammateId, reason }`: Backlog starts its thread; started: reassign            |
| `POST /tasks/:id/complete` | a person marks it done                                                            |
| `POST /tasks/:id/reopen`   | back to Doing (or Backlog without a thread)                                       |
| `POST /tasks/:id/trash`    | into the Trash; `/restore` brings it back                                         |
| `DELETE /tasks/:id`        | the task goes; its thread stays a plain thread (also the "undo" of `create_task`) |

Changes broadcast `task.updated` to dashboards.

### Assign

- Backlog: the thread starts on the workspace computer, else the assigner's own
  online machine, the first where they have an account with usage left for the
  teammate's harness (an agent's: its own thread's computer). If it cannot
  start, the task stays in Backlog with nobody assigned, and the caller is told
  why (`startError` on create).
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
  teammate (or Unassigned) and thread status. Clicking it opens a side sheet:
  details, edit, Assign (backlog), Reassign, Mark done / Reopen, Archive, Move
  to Trash, Open thread. Archived and Trash views beside the board; a trashed
  task offers Restore and Delete for good.
- **New task** dialog: title, description, priority, assignee (Nobody yet:
  Backlog).
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
- A backlog teammates pick work from by themselves, ordered by priority.
- Emptying the Trash after a while.
- Tasks from triggers.
- Measuring `create_task` undo and "Make this a task" rates to tune when agents create tasks.
