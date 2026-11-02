# Board

The **Board** (`/app/board`, between Inbox and Lists in the sidebar) shows what moves across a
workspace: the lines of its lists that have work on them, its threads on no list, and its
failing routines. It answers "where is everything?", where Today answers "what changed since I looked?".
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
  - A routine's run threads are never cards: the Routines page and Today say what they did, and a
    line they work on is its card. A routine that fails is one card in Needs you, the routine and not
    its run (`failingRoutines`, src/failed.ts).
- **Needs you is the same everywhere**: an open ticket or question in the thread or its
  children, a teammate waiting on an answer (or a person who took the thread over), a pull
  request ready for a person to merge or decide, choices nobody picked (below), a failed thread
  or routine (src/failed.ts). The sidebar, Today, the app badge, notifications, the Tasks board
  and a list's Needs you tab count the same things. The Board is the workspace's, like a list's
  tab; Today and the badge are the member's own.
- **Choices wait on a person** (src/choices-waiting.ts). A teammate that ends its reply on a
  choices card offered alternatives for someone to pick, and the thread stops there: without
  this, it showed as Stopped among every other quiet thread, and the reply was lost there. Its
  card says "Pick one", with the card's question as its note. It waits while the thread is idle,
  until a message comes in it (a pick is one; so is a wake-up, which closes the card in the
  thread too), and on whoever started it, as a failed thread does. A choice nobody made in 7
  days closes with its thread, as Stopped does. Reply buttons ("Build it", "Not yet") do not
  wait: they offer a next step a person may leave, and almost every reply ends on some; Today
  lists those it left as loose ends.
- **What a member put away for later is not theirs to see here.** A thread they put away
  (Do later, `src/later.ts`) no longer waits on them anywhere, so on their Board it is like an
  archived one: no card in Needs you or In progress, not Stopped, and a list's line it alone
  carries leaves the Board too. What it did this week stays in Done. Other members still see it,
  and anything new in it brings it back for everyone.
- **In progress** is a thread at work (or its children it waits for), one waiting on a wake-up it
  set, or one whose pull request is being reviewed or fixed. A thread that failed on an error the
  runner tries again by itself stays here until those tries are over (src/failed.ts).
- **A card shows its next wake-up**: an alarm and the time of the earliest pending wake-up of its
  threads (the full date on hover), in any column but Done, so it says when its teammate comes
  back on its own.
- **Done** is a line ticked through Brigade (a teammate's `complete_item`, a merged pull request
  that closes it) or a thread declared done (below), in the last 7 days. A line a person ticks in
  the file has no date, so it shows only in its list. A thread whose task was completed on the
  old board counts as done too.
- **Stopped, then closed.** A thread that is idle, not done, with nothing pending is not lost: it
  shows under the columns as Stopped, with Mark done and Archive for who may write in it. After 7
  days without activity it leaves the Board as closed with no activity, listed under Done apart
  from what was done, and anything new in it brings it back. A list's line whose threads all
  stopped with it open (`stalled`) shows there too, until its last thread closes; it then is an
  open line of its list again. "N stopped" in the summary at the top opens it and scrolls down
  to it.
- **A column is never taller than the window.** From a tablet's width up, each column stops at
  the window's height, less the header above it and room for the Stopped bar below, and its
  cards scroll inside it, their edges fading where more is hidden. A short column keeps its
  height. The page itself still scrolls, down to Stopped.
- **No routines section.** A healthy routine neither waits on a person nor moves, so its row
  only pushed the columns down. A failing one is already a card in Needs you; the routines and
  what their runs did are on the Routines page and Today (`GET /api/board` still returns them for
  Today).
- **Cards say little.** The title; the list and section only for a list's line (nothing for a
  thread on no list); a note on one line (two for an error); the teammate's avatar and name. In
  Needs you, what to do, on the right ("Merge #15, #16", "Answer ticket", "Reply", "Failed").
  In progress has no label: the column says it moves, and a violet dot on the avatar says the
  teammate works right now. One pull request chip, the latest, its color saying its state, with
  "+N" for the others. Done adds who ticked it, when it isn't the teammate, and when.
- **Filters**: project, lists (several at once, plus Not on a list) and teammate, kept in the
  address (`?project=`, `?list=` repeated, `?teammate=`). A list's page links to the Board on that
  list. A Filter button offers the filters not set yet; each one set shows as a pill after it
  ("Project Brigade", "List Backlog +1") that reopens its choices, with an × to remove it, and
  Clear appears once two are set. The list choices show their counts and stay open while ticked.
- **Live**, reloaded once a burst of changes settles (threads, tickets, pull requests, lists,
  schedules, tasks), not on each one.
- **On a phone**, one column at a time, chosen like a list's tabs.

## Done

A thread's done is a fact someone declares, never one read from its silence (`Session.doneAt`,
`doneSummary`, `doneByType`, `doneById`; `apps/api/src/thread-done.ts`).

- **Its teammate declares it** with `complete_thread({ summary })`, one line on what was
  delivered, in the turn that delivers it. Only in a top-level thread a person or a trigger
  started: a child reports, a playbook's run ends with `playbook_report`, a schedule's run with
  its turn. Audited as `thread.done`.
- **Brigade refuses it while anything is open**, and says what (`openWork`): a ticket or question
  in the thread or its children; a pull request opened from them still open; a child it waits for
  that has not reported (a review is one); a wake-up the teammate set; a person's queued message;
  a list item it works on not ticked, unless what remains of it is a line of its own. The write
  checks again, so something opened meanwhile is not missed. Refusals rest on these records,
  never on reading the brief: a teammate once declared work done without the review its brief
  asked for in prose (Paperclip's lesson, in the investigation above).
- **A person marks it done** (Mark done in the thread's menu, or on a Stopped row of the Board;
  `POST /api/threads/:id/done`, optional `summary`), whatever is open: who may change the thread,
  never a child. Reopen (`DELETE`) clears it. Audited as `thread.done` and `thread.reopened`.
- **It reopens when a person or new work shows up**, on the root: a member's message or mail, a
  ticket or pull request opened in it or a child. The teammate's own wake-ups, a child's report,
  a schedule's run and Brigade's notes leave it done.
- **A merge wakes its teammate** once per pull request, at once, asking it to declare the thread
  done or say what remains: a merge is not done by itself (a deploy to check is often left). Not
  while the thread works, waits or is paused, nor once done or archived, nor while another of its
  pull requests is open, nor in a child, a schedule's or a playbook's run.
- **Mark done stays a fallback.** Teammates declare done themselves in the common case; a thread
  that stops without it shows as Stopped, then closes after 7 days. How often people still mark
  threads done by hand says whether teammates need one more nudge at the end of a turn.
