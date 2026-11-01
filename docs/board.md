# Board

The **Board** (`/app/board`, between Inbox and Lists in the sidebar) shows what moves across a
workspace: the lines of its lists that have work on them, its threads on no list, and its
routines. It answers "where is everything?", where Home answers "what changed since I looked?".
Its design is `Projects/Brigade/designs/board.design` in the library; how competitors handle the
same question is `Projects/Brigade/investigations/agent-work-tracking-competitors.md`.

## Decisions

- **A view, not a store.** The API computes it on each read (`GET /api/board`,
  `apps/api/src/board.ts`) from the lists (`workspaceLists`, the same reading as the Lists page),
  the threads and the schedules. It keeps nothing of its own, so it can't fall behind them. The
  old Tasks board stays at `/app/tasks` with its data while the Board settles (docs/tasks.md).
- **Three columns, all computed.** Needs you, In progress, Done (the last 7 days). Nobody drags a
  card: where it stands follows from its threads, tickets and pull requests. There is no "To do"
  column: work is planned in a list's file, where the order of the lines matters.
- **A card is a list's line, a thread on no list, or a failing routine.**
  - A line with work on it (a thread or a pull request) is the card; its threads are not cards
    of their own. Its state is the list's (`stateOf`, docs/lists.md).
  - A thread on no list, top-level (a child thread shows in its parent), not archived, active in
    the last 14 days or done this week.
  - A routine's run threads are never cards: the routine's row says what they did, and a line
    they work on is its card. A routine that fails is one card in Needs you, the routine and not
    its run (`failingRoutines`, src/failed.ts).
- **Needs you is the same everywhere**: an open ticket or question in the thread or its
  children, a teammate waiting on an answer (or a person who took the thread over), a pull
  request ready for a person to merge or decide, a failed thread or routine (src/failed.ts). The
  sidebar, Home, the app badge, notifications, the Tasks board and a list's Needs you tab count
  the same things. The Board is the workspace's, like a list's tab; Home and the badge are the
  member's own.
- **In progress** is a thread at work (or its children it waits for), one waiting on a wake-up it
  set, or one whose pull request is being reviewed or fixed. A thread that failed on an error the
  runner tries again by itself stays here until those tries are over (src/failed.ts).
- **Done** is a line ticked through Brigade (a teammate's `complete_item`, a merged pull request
  that closes it) or a thread declared done (below), in the last 7 days. A line a person ticks in
  the file has no date, so it shows only in its list. A thread whose task was completed on the
  old board counts as done too.
- **Stopped, then closed.** A thread that is idle, not done, with nothing pending is not lost: it
  shows under the columns as Stopped, with Mark done and Archive for who may write in it. After 7
  days without activity it leaves the Board as closed with no activity, listed under Done apart
  from what was done, and anything new in it brings it back. A list's line whose threads all
  stopped with it open (`stalled`) shows there too, until its last thread closes; it then is an
  open line of its list again.
- **Routines above the columns.** One row per routine (schedules; a playbook's show on the
  Routines page): its health, what its runs did today, and its next run.
  - Health from its runs of the last week: Failed when it could not start or its last finished
    run failed, Degraded when a run failed this week but the last one did not, Paused, OK, New
    before its first run.
  - Today's runs (in the routine's time zone): the pull requests they opened first, then those
    that found nothing, counted and never listed one by one (a run reports `nothing`).
- **Filters**: project, lists (several at once, plus Not on a list) and teammate, kept in the
  address (`?project=`, `?list=` repeated, `?teammate=`). A list's page links to the Board on that
  list, where only the routines whose runs worked on its lines this week show.
- **Live**, reloaded once a burst of changes settles (threads, tickets, pull requests, lists,
  schedules, tasks), not on each one.
- **On a phone**, one column at a time, chosen like a list's tabs.

## Done

<!-- The done fact: declared, refused while anything is open, reopened by a person. -->
