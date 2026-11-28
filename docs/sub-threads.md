# Sub-threads

A teammate splits work across sub-threads (`start_child`): each a thread with a fresh context and a
brief of its own, out of the sidebar's list and folded under its parent, whose report comes back to
the thread that started it. They serve any kind of work, not only code: research, outreach, design,
video, operations. What changes with the work is how its inputs and results travel, and the computer
each part runs best on.

The goal is the most outcome per token and per minute of a person's attention, not the most agents
at once: teammates run on members' own subscriptions, so a sub-thread that did not need to exist
costs the member. The teammates' instructions say so (see Fanning out), and the tree has a cap.

Decided in `Projects/Brigade/decisions/agent-swarm-spec.md` (library, 28 Nov 2026).

Code: `packages/contracts/src/children.ts` (limits, operations, notes, the tree's types),
`apps/api/src/children.ts` (start, reports, waking, follows, the tree's cap),
`apps/api/src/started-threads.ts` (`message_thread`, `writableThread`, `treeRelation`),
`apps/api/src/thread-tree.ts` (the Tree section), the runner's `childTools`
(`apps/runner/src/harness/tools.ts`), `pushForSubthread` (`apps/runner/src/repos.ts`), and in the
dashboard `components/sidebar-threads.tsx`, `lib/sub-threads.ts`, `components/thread-tree.tsx`.

## The tree

A thread at the top and every sub-thread under it make a tree.

- **Two levels.** A thread at the top starts sub-threads (level 1); a level-1 sub-thread may start
  its own (level 2); a level-2 one starts none: start_child says "This sub-thread is 2 levels deep,
  the most Brigade allows: do the work here, or say in your report what else is needed".
  `SUBTHREAD_DEPTH = 2`.
- **Eight at work per tree**, counted from the top over both levels: the 9th start_child is refused
  until one reports (or is cancelled). `SUBTHREADS_AT_WORK = 8`. At work: started by start_child
  (`origin` child), no report yet, not failed or done. Not a schedule's runs that report to a
  thread, nor the review of a pull request: Brigade starts those (one per pull request, its looks
  capped), and a review is never refused for the cap. A finished sub-thread a message sets to work
  again (message_thread, from its parent or another thread of the tree), or retried after a failed
  turn, counts as one more, and is refused when the tree is full (`reopenInTree`). Its place is
  taken only once nothing else refuses the message, and given back, with its report, if the message
  or the retry does not go (a person in control, the computer offline). A failed one is idle again
  once reopened, so that it counts at once.
- Both are constants in `packages/contracts/src/children.ts`, read by the API (which enforces them)
  and the runner (which says them in the teammates' instructions and tools). No person sees or sets
  them; changing either is one line.
- **`Session.rootId`**: the tree's top, set on every sub-thread at its start (null at the top). A
  sub-thread started before it has none: its parent is the top then (`inTree` reads both). The cap
  counts a tree in one query.
- **One place at a time per tree.** The new sub-thread's row is made in one short transaction that
  takes `pg_advisory_xact_lock('tree:<root>')`, counts, and inserts (startThread's `guard`), so two
  starts at once never both take the last place, and no connection is held while the rest of the
  start runs. Reopening a finished one takes the same lock with its count.
- Reviews: Brigade starts the review of a pull request a level-1 sub-thread opens under it (level
  2), and none under a level-2 one (as before: "below which Brigade starts no review"), so nothing is
  ever deeper than level 2.
- **A sub-thread reports up after its own.** One that waits for sub-threads of its own (or whose
  note from them is still to reach it) sends no report when its turn ends, and `report` is refused
  (`childrenHold`), as for a review under way; `needs_parent` still goes. The turn their note brings
  reports up, also once its wait for them ran out.

## Where a sub-thread runs

`start_child`'s `computer`:

- `same` (default): its parent's computer, as before.
- `cloud`: the workspace's cloud computer, for long, heavy or unattended work (renders, scraping, a
  suite of tests, work that must go on with the laptop closed). One that is stopped starts as work
  comes, as for any thread.
- `mine`: a machine of the member the tree works for (the threads' `startedByMemberId`, which every
  sub-thread inherits): their only one, or `{ mine: "<name>" }` when they have several. For their Mac
  apps, their signed-in browser, computer use. **Never another member's machine**, and only on the
  word of that member: not when another member asked in a thread shared with them, nor in a thread
  an outside event or a schedule started (`askedBy` must be the machine's member). The same holds
  for every later message to a sub-thread on a member's machine from a thread on another computer
  (`machineRefusal`), its parent's included.

Refused at once with the reason, never by falling back to another computer: the machine is offline;
its runner is older than `SUBTHREADS_PROTOCOL`; or no account of the teammate's login (`loginOf`) is
signed in there for that member (`usableAccounts`). The parent then picks another computer or asks
the person. The sub-thread runs on that computer's accounts of the member, never the parent's account
from another computer.

### Inputs

They travel with the brief, whatever the work:

- **files**: `start_child`'s `files`, by path as the teammate sees them. Its harness reads and
  uploads them first (`reportWithFiles`, as a report's files the other way), and the API gives them
  to the sub-thread with its first message (`attachmentIds`), in its working folder.
- **library documents**: named by path in the brief; every computer reads the library already.
- **code**: `repos: [{ repository, branch }]`. The parent's runner pushes each branch to GitHub first,
  from its checkout of that repository (`pushForSubthread`); refused, saying so, when that checkout is
  on the branch with uncommitted changes, new files included (named in the error). A branch that is
  only on GitHub is there already. On a member's machine the checkouts are found with Node, not
  `find` (Windows has no GNU find). The brief
  tells the sub-thread to check it out with that base and work on a branch of its own.

Results come back as before: the report, through the API, with its files in the parent's working
folder; documents saved to the library; pull requests on GitHub.

## Reports and waking

- `wake: 'all'` (default, as before): the parent is woken once every sub-thread it waits for has
  reported, or its wait ran out (`settleAwaited`).
- `wake: 'each'`: every report of that sub-thread wakes the parent (`Session.wakeEach`), `nothing`
  included; reports that come during one of its turns queue as wake-ups do and come on its next. It
  is not awaited with the others, and a message to it (message_thread) keeps it so.
- **`needs_parent`**: a report status for a decision its parent can make. It wakes the parent at
  once, alone, whatever `wake` says (`deliverReport`); the others it waits for still come together.
  The parent answers with `message_thread`, which sets the sub-thread to work again and waits for it
  again. Only what the parent cannot answer reaches the person: a level-2 sub-thread's `needs_parent`
  goes to its level-1 parent, which may answer or report `needs_parent` up in turn; a person is
  asked with a ticket, or `needs_person`, as before.
- Each sub-thread reports to its own parent, which reports up.

## Messages within a tree

`message_thread` writes between any two threads of the same tree (the top and sub-threads at both
levels), under the 5-in-a-row cap (`COMMENTS_IN_A_ROW`). The first line the receiving teammate reads
says who sent it and its relation, seen from the receiver: `parent`, `child`, `sibling` (same parent)
or `tree` (any other), as "**Riley** wrote from the sibling thread “…”" (`treeMessage`). A message
to one's own sub-thread is told as before (`messageChild`: it carries on and reports again). A
review is asked to look again only by the thread that opened its pull request. A playbook's run
writes only within its own tree.

## Following

`follow_thread` works on any thread the teammate may write in (`writableThread`, the same rule as
`message_thread`): a thread of its own tree, one it started (start_thread), another thread at the top
it is a teammate of; in a playbook's run, also a child of another run of the same installation (as
before). Its people must be allowed to write there, as for a message (`peopleMayWrite`), when it
follows, again when a report is delivered (one no longer allowed is claimed without a wake-up), and
when `read_child` reads it.
Its next report wakes the follower, at most `FOLLOWERS_PER_THREAD` (20) each. A thread at the top
keeps no report: the end of each of its turns tells its followers what its last message said
(`noteFollowedEvents`), once; a follow is marked with the time of the end it heard, so a later end
is news whatever happened between. One its delivery missed (a failed wake-up, an API restart) is
woken by the minute's sweep, which reads that turn's end again from the events (within the hour).

## The sidebar

- A level-2 sub-thread hangs under its level-1 parent with the same branch line and rounded elbow,
  one step further right; a level-1 sub-thread with sub-threads has the same caret after its title,
  folded by default, its unfolded state kept by this browser (`brigade:sidebar-children`).
- **What waits on a person rises.** A row with sub-threads shows the dot of the most urgent state
  below it (`urgentBelow`): needs you first, then working; a failed one keeps its red dot. A level-2
  "needs you" is never hidden under two folds.
- `CHILD_CAP` (5 before "+N more") applies at each level; Enter folds and unfolds at each level.

## The Tree section

Thread details show a Tree section for a thread with sub-threads (`GET /threads/:id/tree`): each
sub-thread below it at its level, on a branch line, with its teammate, computer, state (working,
waiting for its own, needs you, needs parent, failed, done, cancelled, idle), the line of a list it
works on, what it produced (pull requests, library documents it saved, files it sent) and its
tokens; the whole tree's tokens in the title, counted as Usage counts them (input and output, from
the top). Stop a working one (`POST /threads/:id/interrupt`) or retry a failed one
(`POST /threads/:id/retry`) from there. A dashboard on an API before it shows the sub-threads'
lines, as before.

## Fanning out

The teammates' instructions (`apps/runner/src/instructions.ts`, `SWARM`) and `start_child`'s
description say: do the work yourself unless it splits into parts that are independent, long, or
need another computer or teammate; say in one line of the brief why this part is a sub-thread and why
on that computer; prefer few sub-threads with full briefs to many small ones; a sub-thread starts its
own only for a part that splits again, never to hand its whole task down.

## Compatibility

The dashboard, API and runner deploy separately.

- **Protocol 57** (`SUBTHREADS_PROTOCOL`). The API sends every thread `ThreadSpec.tree` (its level
  and top). A runner offers start_child's new fields, start_child in a level-1 sub-thread,
  `needs_parent` and follow_thread outside playbooks only where its spec has `tree`: an older API,
  which would drop them, gets the tools as before. An older runner ignores `tree` and offers none of
  it.
- `computer` other than its parent's is refused, with a clear error, on a target computer whose
  runner is older than 57.
- The database only adds: `Session.rootId`, `Session.wakeEach`, and `needs_parent` in the report's
  existing JSON. An older API reads neither column; an older dashboard shows a `needs_parent` report
  by its status word.

## Measuring it

A fixed benchmark, run before and after, with two jobs handed to one thread: code (10 items like
those of `Projects/Brigade/backlog.md`), and other work (a launch kit: competitor research, a landing
page draft, five X posts, a 30-second video, one part on the member's Mac). Measured from the events
(`docs/harnesses.md`, Benchmark): deliverables accepted, hours to the last one, minutes a person
spent, tokens per accepted deliverable, sub-threads started per deliverable and per level. Success:
more accepted per hour with no more tokens per deliverable than one thread doing them in a row.
