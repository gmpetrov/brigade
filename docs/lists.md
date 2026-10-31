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
  conversion (`packages/editor/src/markdown.ts`). A line whose text goes on below its box (a
  line break typed in it, saved as `\` at the end of the row) is one line with all its rows
  (`ListLine.end`), and its marker counts on any of them: a line break typed before the chips
  moves the marker to the next row. Its rows end at a blank row or a block of its own (a list
  line, a heading, a quote, a thematic break, HTML other than a row holding only its marker).
- **`ListItem` keeps what the file cannot**, by that id: the threads on the line
  (`ListItemThread`), the pull requests on it (`ListItemPull`, `closes` or what `remains`), who
  ticked it from Brigade (`doneBy*`), the item it is what remains of (`remainderOfId`) and its
  text when last seen. A line or marker removed from the file
  leaves its row: the thread's card says the item is no longer in its list, and nothing ticks
  it. Brigade never guesses which line it became.
- **A line is not a thread.** A thread can carry several lines and a line several threads.
  Handing lines over starts one thread for them all, or one each; lines can also be added to
  a thread that runs already, which the person then hands them over in as a message of theirs
  (`handOffMessage`), so its teammate starts on them at once. A note telling it at its next turn
  (`thread.note`) only stands in when that message can't go (the thread waits on a decision or a
  daily cap, its computer is off), with the person's note in it (`apps/web/lib/hand-off.ts`).
  In the thread, that message (and the first one of a thread started for lines) shows as a
  quiet line, "Handed over 1 item of launch.md" with the lines folded under it, rather than as
  the person's bubble (`handOffParts`, `handOffNote`); one with a note the person wrote stays
  their bubble. The teammate still receives the whole message.
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
  it. A note holding a link goes without italics (`— Live at www.example.com`): the editor
  saves italics around a link back broken, with more asterisks each time. Brigade writes the file only to mark, tick or add a line; the collab server applies the
  change to the lines it touches, so people's live edits elsewhere stay.
- **Done means checks anyone can verify.** When a teammate takes on an item, it says in a line what
  done means for it ("Done when: …"), unless the line says it; the person corrects it. A pull
  request's description goes through those points, each done or left. People write lines fast,
  so the teammate writes this, not them.
- **A merged pull request ticks only what it closes.** A teammate names the items a pull request
  works on when it opens it (`github_create_pull_request`'s `items`): `closes` for those every
  point of which holds once it is merged, ticked on merge (`settleItemsOnMerge`); `partOf` for
  the others, each with what `remains` of it (a deploy to check, a setting, a step only a person
  can do). The tool refuses a `partOf` without it: work left only in a pull request's description
  was lost (the list never saw it). Each item a merge deals with is settled once done (or for
  good, gone from its list or out of its author's reach); one that failed otherwise is tried
  again every 10 minutes (`sweepListMerges`).
- **What remains becomes a line, and the item follows it.** On merge, what a pull request said
  remains of an item is added under it, nested, attached to the pull request's thread
  (`addRemainder`; its id is kept on the link first, so a retry adds it once). Without a pull
  request, a teammate adds it itself (`add_item` with `remainsOf`). Once all of an item's
  remaining lines are ticked, by anyone and anywhere (a teammate, the thread's card, the editor),
  Brigade ticks the item, credited to Brigade (`settleRemainders`): right away for a tick made
  through Brigade or a save of the file, else by the 10-minute sweep. Not while work on it is on
  its way (a pull request open, or one merged whose remaining line is not added yet), and never
  when a remaining line was removed from the file: that one waits for a person. The remaining
  lines are read under the file's lock, where each one is made with its row, both before the tick
  and when deciding one was removed, so one unticked or added meanwhile keeps the item open; and they are looked at again until the item is done, so a pull request closed
  later still lets it be ticked.
- **A problem the work shows goes on the list.** When a thread working on a list's items finds a
  problem that stands in the way of what the list is for (a launch blocker, not a remark in
  passing), its teammate adds it as a line of its own (`add_item`, in its section) and names the
  lines it added in its reply, so the person can remove one. Left only in a reply, such a problem
  was lost: the docs review of a launch checklist found three and the list never saw them.
- **Work without a pull request is ticked by the teammate** (`complete_item`), only with what
  shows it is done in its note (the tool refuses a tick without one). When done is a matter of
  judgment (a video, copy, a design), the teammate shows it and leaves the tick to the person,
  with a "Tick it" reply.
- **Where a line stands comes from its threads**: done when ticked; needs you when one of its
  threads waits on a person; in progress when one works or a pull request on it is open; else
  open. The list's counts and filters read the same. An open line with threads, none of them
  working or waiting, no open pull request and no open remaining line, is **stalled**: nothing
  will tick it, so it shows "Stopped, still open" for someone to tick it or say what remains.
  It is the net for work done without a pull request, where no merge shows on the line.
- **Within the library's access.** Members read every list. A teammate reads and changes a list
  only as its folder's access lets it (`teammateLibraryAccess`); marking a line counts as
  changing the file. A thread's items reach its teammate (spec, `list_items`) only from lists it
  may read, and a pull request closes only items of lists its author may change, checked when
  it is opened and again when it merges; elsewhere it is only part of the work.
- **The Tasks board is set aside, not removed.** Lists replace it in the navigation; the board
  stays at `/app/tasks` and its data is kept. A line nobody has started is the backlog.

## Dashboard

- **Lists** (`/app/lists`, under Library in the sidebar): every list of the library, one row
  each, grouped by the project whose folder holds it (projects in the order of their last
  changed list, lists outside every project last), last changed first or by name, with a search.
  A row's dot alone says where the list stands (orange: a line waits on a person; violet: one is
  in progress); under its title, its count and that line. Wide, a bar shows how far it is; on a
  phone, a line under the row once anything is ticked.
- **In the sidebar**, the threads working on a list's items fold under one row for the list,
  where its first thread would be, as a thread's child threads do (`lib/list-groups.ts`). Its
  title opens the list, its caret folds its threads, and its dot is its threads' most pressing
  state (waiting on a person, then working), so a thread that needs someone is never hidden
  behind a quiet row. A thread with items of several lists goes under the first it was given.
  Lists group, sections do not: a list's page shows its sections. Pinned threads stay under
  Pinned; the archived and Later views show threads as they come.
- **Pinning a list**: the list's row has a menu (⋮, or a right-click) whose Pin puts it under
  Pinned, each member's own (`ListPin`), among their pinned threads and dragged with them (one
  order, `PUT /api/threads/pins/order` with the list as `list:<documentId>`). Its threads go with
  it, out of Threads, however old (`GET /api/threads` loads them); with none, the row stays and
  opens the list. `GET /api/lists/pins`, `POST|DELETE /api/lists/:documentId/pin`.
- **A list** (`/app/lists/<documentId>`): the file in the document editor, its progress, and
  filters (All, Open, In progress, Needs you, Done) that hide the other lines (CSS over each
  line's state, `globals.css`); a line that does not match but holds a sub-line that does stays
  above it as a small grey breadcrumb (no box, chips or note). Each line with work on it shows
  its threads (state dot, teammate, title, "needs you"), pull requests (what remains after one,
  in its tooltip) and "Stopped, still open" when stalled (`components/list-items.tsx`); the same
  chips show wherever the file opens, such as the document panel.
- **Recently done**: above the Done filter's lines, the items Brigade ticked in the last 14 days
  (a merged pull request, `complete_item`, a tick from a thread's card), newest first, by day,
  each with who ticked it and its pull requests and threads (`lib/recently-done.ts`). Only those
  have a date (`ListItem.doneAt`): a line a person ticks in the file has none, so it shows only
  in the list below, in the file's order. Brigade does not date people's own ticks: it would mean
  marking every ticked line and comparing each save of the file, for what they already know.
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
- `complete_item` ticks a line, by id or by text with the list's path, with a note saying what
  shows it is done (required).
- `add_item` adds a line after another (or nested under it), at the end of a section, or at the
  end of the file, attached to the thread; with `remainsOf`, nested under that item as what
  remains of it.
- `github_create_pull_request` takes `items: { closes: [id], partOf: [{ item, remains }] }`.

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

- A pinned list's progress in its sidebar row.
- Making a new list from the Lists page (a new Markdown file with a checkbox does it).
- A line's state from its threads' open tickets alone (a thread waiting on a ticket is already
  `waiting`).
