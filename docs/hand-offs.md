# Threads teammates start

Work lives in **threads**. When work should go on by itself rather than report back, a teammate
starts a **thread of its own** for it, at the top, in the sidebar: a goal of its own that came up
while talking about something else, work Chief hands to another teammate, a list's line a routine
hands out. It replaced the Tasks board (below).

## Decisions

- **A thread, not a task.** `start_thread` (`apps/api/src/started-threads.ts`) starts a plain
  top-level thread for a teammate, itself by default, with a brief that stands alone as its first
  message (`startedThreadBrief`: who started it and from which thread, then the title and brief).
  It runs on the calling thread's starter's accounts, on the same computer, for whoever asked there
  (`askedByMemberId`), in the project given, else the one whose folder holds its list, else the
  calling thread's. On Chief's word, its work goes on Chief's word too (docs/chief-answers.md).
- **Lines of a list come with it.** With `list` and `items`, the lines are picked as `link_items`
  picks them (`pickLines`: by id or text, marked when they have none, within the teammate's
  library access) and linked before the first turn, as a person's Hand to does: the line shows the
  thread at once, and a routine handing out lines never takes the same one twice.
- **Where it came from stays.** `Session.startedFromId` names the thread that started it: its
  details link back there (From …), and that thread may write in it later.
- **message_thread writes in a thread it started, or a child.** Headed with who wrote it and from
  where (`threadComment`, the words the Tasks board's comments used, so old ones read the same),
  under the starter's rights to write there; it reopens the thread if it was done. Nowhere else:
  threads do not write in each other's (docs/decisions.md).
- **Not from a playbook's run.** What started the run is untrusted, and a thread outside it has
  none of its limits: a run starts no thread outside it and writes only in its own children.
- **A customer's idea goes to a list.** A live playbook run keeps one with `file_idea`
  (`apps/api/src/playbook-ideas.ts`): one line at the end of the playbook's ideas list, linked to
  no thread, which starts nothing. The list is the playbook's `ideas` setting (a library path, with
  a section's heading after `#`), else `ideas.md` in its project's folder, or at the library's
  root, made when missing as Chief's parked list is. The run never picks where: a line written in
  another list or section could be work a routine takes up. Only where its teammate may save. A dry
  run says where the line would go and writes nothing.
- **One goal, one deliverable.** A person's attention is what is scarce: a goal of days or several
  pull requests reaches them as one finished, checked result (for code, one pull request), with no
  plan to approve and no steps to review; they are asked only for what the work cannot go on
  without. A mission of nine tasks made a person follow nine pull requests, and planned deliveries
  (tried on 2026-10-19) still made them review and decide more than they wanted. Its parts get no
  thread of their own: the teammate does them itself (Claude Code's sub-agents for parallel or side
  work), and starts a child thread only for what must outlive its turn, is for another teammate or
  may need a person. The rules are in the session instructions (`bigGoals` in
  `apps/runner/src/instructions.ts`).

## The Tasks board, and why it went

From 2026-10-11 a **task** was work to see finished on a Tasks board (Backlog, Needs you, Doing,
Done), with one thread per task, missions grouping tasks, and seven teammate tools (`create_task`,
`list_tasks`, `update_task`, `assign_task`, `move_task`, `complete_task`, comments). On trial from
2026-10-19, work lived in threads: nobody opened the board, and a task repeated its thread (its
status, its Needs you, its pull requests). Lists replaced it in the navigation on 2026-10-29
(docs/lists.md), and the Board, computed from lists and threads, came on 2026-11-01
(docs/board.md). The board went on 2026-11-05, with what still leaned on it replaced:

| Was                                       | Now                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `create_task` for a teammate, or oneself  | `start_thread`                                                         |
| A comment on a task's thread              | `message_thread` to a thread it started                                |
| `complete_task`                           | The thread declared done (docs/board.md)                               |
| A playbook's idea in the Backlog          | `file_idea`, a line of the playbook's ideas list                       |
| The Backlog                               | A list's lines nobody has started (docs/lists.md)                      |
| Needs you, Doing, Done                    | The Board, the sidebar and Today, from threads and lists               |
| "X finished a task" pushes                | "X finished" when a teammate declares a thread done (src/notifications.ts) |
| `/app/tasks`                              | Redirects to the Board (a project's, to the Board on that project)     |

- **Runners update after the API.** A runner before protocol 52 still offers the task tools and
  sends them as `task.call`; the API answers each with what replaced it (`src/legacy-tasks.ts`):
  `create_task` for a teammate starts its thread, `self` says to work here, Backlog says to add a
  line to a list (in a playbook's run, it files the idea), a comment is `message_thread`,
  `complete_task` declares the thread done; the board's own changes are refused. It goes once no
  older runner connects.
- **Its data stays one deploy.** Migrations only add (they run before the API that reads them is
  deployed): the `Task` table and `Session.taskId` stay, unread, and go in a later deploy. The
  migration that took the board away (`20261105230000_tasks_gone`) declared done each thread whose
  task was done and that was not (`doneAt` from `completedAt`, by whoever completed it in the audit
  log, else Brigade), so the Board keeps what it showed. Tasks still in the Backlog, never started,
  are left in the table: before it is dropped, those worth keeping go into a list.
