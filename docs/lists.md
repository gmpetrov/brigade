# Lists

A **list** is a checklist in a Markdown file of the library: a launch checklist, an onboarding
plan, a backlog. People write it as they like (sections, notes, priorities, nested lines) and
hand its lines to teammates. Each line then shows the threads working on it and their pull
requests, and gets ticked as the work lands. Lists are how a person organizes and follows a
mission; threads stay where the work happens.

## Decisions

- **The file is the list.** No list type to create and no separate store: any library
  Markdown file with checkboxes (`* [ ] …`) is a list, shown under Lists. Its lines, their
  order, sections and notes, and whether each is ticked, live in the file only, which people
  and teammates read and edit as any document. Brigade never keeps a copy of a line's state.
- **A line work is attached to carries a marker**, `<!-- item:<id> -->` at its end, hidden in
  the editor (where it renders as the line's chips) and in any Markdown viewer. Its id names
  the line across edits: rewording or moving it keeps the id. A line
  nobody handed over has no marker. A line copied with its marker is a new line: the first one
  keeps the id, and the copy gets one of its own when it is handed over. An id is never taken
  over from another list or workspace: a line whose editor marker names one gets a new id. The editor and the API keep markers through every
  conversion (`packages/editor/src/markdown.ts`).
- **`ListItem` keeps what the file cannot**, by that id: the threads on the line
  (`ListItemThread`), the pull requests on it (`ListItemPull`, `closes` or not), who ticked it
  from Brigade (`doneBy*`) and its text when last seen. A line or marker removed from the file
  leaves its row: the thread's card says the item is no longer in its list, and nothing ticks
  it. Brigade never guesses which line it became.
- **A line is not a thread.** A thread can carry several lines and a line several threads.
  Handing lines over starts one thread for them all, or one each; lines can also be added to
  a thread that runs already (its teammate is told at its next turn, `thread.note`).
- **One change of a list's file at a time.** Every save of a Markdown library file takes the
  file's lock (`withLibraryLock`), and Brigade reads, changes and writes a list under it, so no
  save lands in between and is lost. The lock is a lease row (`LibraryLock`, 30 s): waiting for it
  holds no database connection, a crashed holder frees it when its lease ends, and a holder past
  its lease writes nothing more: its row changes only while the lease is still its own (checked
  atomically, `lease.fence`). Its bytes may still land late: each save writes them to an object of
  its own (`LibraryObject`, `src/library-objects.ts`), and pointing the file's row to it is the
  save's only commit, so a late write, or a crash right after one, lands where nobody reads, and
  the sweep deletes it. Readers (the editor, lists, the runner's mirror, downloads) all read the
  object the row points to. A file not saved since this came keeps its bytes at its old key, which
  saves overwrote; one marked then (`Document.bytesStaleAt`) is saved again from what its row says
  (its full text, or the saved version with its sha) as an object of its own, by a sweep every
  minute until it is (`repairBytes`), and a list's edit is refused while there is no such source.
  A person's live save built on an older text is refused (409) and the collab server reconciles
  first.
- **Ticks are changes to the file, made by code.** Ticking marks the line's box (`[x]`) and may
  add a short note after its text (`*PR #491, 29 Oct*`), a save of its own credited to who did
  it. Brigade writes the file only to mark, tick or add a line; the collab server applies the
  change to the lines it touches, so people's live edits elsewhere stay.
- **A merged pull request ticks only what it closes.** A teammate names the items a pull request
  works on when it opens it (`github_create_pull_request`'s `items`): `closes` for those it
  finishes, ticked on merge (`settleItemsOnMerge`), `partOf` for those it only advances, shown
  on the line and left open. Each item a merge closes is settled once ticked (or for good, gone
  from its list or out of its author's reach); one that failed otherwise is tried again every 10
  minutes (`sweepListMerges`). A merged pull request does not prove an item done (a deploy may
  remain). Work without a pull request is ticked by the teammate (`complete_item`), with a note.
- **What remains becomes a line.** A teammate adds what an item still needs as a line of its own
  (`add_item`, after or under the item), attached to its thread, rather than ticking what is
  half done.
- **Where a line stands comes from its threads**: done when ticked; needs you when one of its
  threads waits on a person; in progress when one works or a pull request on it is open; else
  open. The list's counts and filters read the same.
- **Within the library's access.** Members read every list. A teammate reads and changes a list
  only as its folder's access lets it (`teammateLibraryAccess`); marking a line counts as
  changing the file. A thread's items reach its teammate (spec, `list_items`) only from lists it
  may read, and a pull request closes only items of lists its author may change, checked when
  it is opened and again when it merges; elsewhere it is only part of the work.
- **The Tasks board is set aside, not removed.** Lists replace it in the navigation; the board
  stays at `/app/tasks` and its data is kept. A line nobody has started is the backlog.

## Dashboard

- **Lists** (`/app/lists`, under Library in the sidebar): every list of the library, last
  changed first, with its progress and what waits on a person.
- **A list** (`/app/lists/<documentId>`): the file in the document editor, its progress, and
  filters (All, Open, In progress, Needs you, Done) that hide the other lines (CSS over each
  line's state, `globals.css`). Each line with work on it shows its threads (state dot,
  teammate, title, "needs you") and pull requests (`components/list-items.tsx`); the same chips
  show wherever the file opens, such as the document panel.
- **Hand over**: select lines in the editor, then **Hand to <teammate>** in its toolbar. A dialog
  asks how: one thread, one thread each, or a thread that runs already, with an optional note.
  The lines get their markers in the editor at once; the API marks them in the stored file too
  when the editor's save has not landed yet. The thread opens in the project whose folder holds
  the file.
- **In a thread**: a **Working on** card at its top lists its items, with their pull requests,
  ticked live; a person can tick or untick one there.

## Teammates

- `list_items` reads a list (lines, ids, threads, pull requests), or this thread's items.
- `link_items` attaches lines to the thread, by id or text, marking them if needed.
- `complete_item` ticks a line, by id or by text with the list's path, with a short note.
- `add_item` adds a line after another (or nested under it), at the end of a section, or at the
  end of the file, attached to the thread.
- `github_create_pull_request` takes `items: { closes, partOf }`.

A thread's items come in its spec (`ThreadSpec.items`) and its instructions list them under
"Your list items" when its session starts; other threads get a short "Lists" section. The
tools are `schedule.call` operations (`ListOperations`), handled in `apps/api/src/lists.ts`.

## API

- `GET /api/lists`: every list, with counts and the next items.
- `GET /api/lists/:documentId`: a list with its items' threads and pull requests.
- `GET /api/lists/threads/:sessionId`: a thread's items.
- `POST /api/lists/:documentId/hand-off`: `{ teammateId, items: [{ id, text }], mode, note? }`.
- `POST /api/lists/:documentId/link`: `{ sessionId, items }`.
- `PUT /api/lists/items/:id/done`: `{ done }`.

Writes to items, their threads and pull requests broadcast `lists.updated`.

## Not done yet

- Pinning a list in the sidebar with its progress.
- Making a new list from the Lists page (a new Markdown file with a checkbox does it).
- A line's state from its threads' open tickets alone (a thread waiting on a ticket is already
  `waiting`).
