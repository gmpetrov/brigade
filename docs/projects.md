# Projects

A project groups the work of one venture or line of work inside a workspace: its threads,
tasks, library folder, GitHub repositories and their saved previews. It is for organizing
and for context, not for isolation. Every workspace resource stays shared: teammates,
computers, AI accounts, connections, the vault, caps and members. A teammate works across
all projects; the **thread** carries the project, and with it the project's context.

This is not the `Project` removed in `6410284` ("remove projects", migration
`20261011040000_remove_projects`). That one wrapped a single GitHub repository and its
checkout setup, and a GitHub connection made it redundant. The name is free again.

## Decisions

- **Organizing, not a boundary.** No permissions, no caps and no member visibility per
  project. When something needs separate people, secrets or billing, it is a workspace.
  When it shares those and only separates the work, it is a project.
- **Not part of scope.** `AuthSession` keeps only the organization and workspace;
  `scoped()` does not change. Pages filter by project through the URL (`?project=<id>`).
- **Optional everywhere.** `projectId` is nullable. A thread or task without a project
  works as one does today, and existing rows need no backfill. Workspaces that never make a
  project see no difference beyond the sidebar section.
- **Things keep their natural owner; the project collects them.** Only what starts work
  (threads, tasks, schedules, triggers) stores a `projectId`. Everything else is reached
  through its thread, its repository or its library folder.
- **One project per item**, like a folder. Not tags.
- **A project focuses, it does not restrict.** A project thread is given the project's
  repositories, folder and preferred connections as defaults. The teammate still reads
  the whole library it is granted and every repository its grants reach.

## What belongs where

| Stores `projectId`      | Reached through the thread or repository           | Shared, never grouped                     |
| ----------------------- | -------------------------------------------------- | ----------------------------------------- |
| `Session` (threads)     | `Ticket`, via `sessionId`                          | `Teammate`, `Computer`, `Runner`          |
| `Task`                  | `PullRequest`, via its thread, else its repository | `Account`                                 |
| `Schedule`              | `PreviewRecipe`, via its repository                | `Connection`, `Grant`, vault, credentials |
| `Trigger`               | `Attachment`, `Comment`, `SessionEvent`            | `Member`, caps                            |
| `DesignSystem` (target) | `ConnectionCall`, `AuditEntry`, thread summaries   |                                           |
|                         | Library files, by path under the project's folder  |                                           |

## Data

```prisma
model Project {
  id             String    @id @default(cuid())
  organizationId String
  workspaceId    String
  name           String
  /// One letter or an emoji, shown in the sidebar.
  icon           String?
  /// Given to every thread in the project: what it is, its stack, who it is for.
  brief          String    @default("")
  /// The project's library folder, e.g. "Projects/Acme web". Files belong to it by path.
  folder         String?
  /// Connection ids to prefer in its threads. A hint in the thread spec, not a grant.
  preferredConnectionIds String[]
  archivedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  repositories   ProjectRepository[]
  sessions       Session[]
  tasks          Task[]
  schedules      Schedule[]
  triggers       Trigger[]

  @@unique([workspaceId, name])
  @@index([workspaceId])
}

/// A GitHub repository the project works on. A repository may be in several projects.
model ProjectRepository {
  organizationId String
  workspaceId    String
  projectId      String    // Project, onDelete: Cascade
  /// owner/name, lowercase, as PreviewRecipe and PullRequest store it.
  repository     String
  createdAt      DateTime  @default(now())

  @@id([projectId, repository])
  @@index([workspaceId, repository])
}

// Session, Task, Schedule, Trigger gain: projectId String? (Project, onDelete: SetNull), indexed with workspaceId
// DesignSystem gains: projects String[] (project ids it applies to)
// DocumentKind gains: project_memory (path projects/<id>.md)
```

### Repositories

There is no `Repository` table, and projects do not add one. A repository exists for
Brigade while an active GitHub connection's installation reaches it
(`workspaceRepositories` in `apps/api/src/git.ts`). Rows refer to it by its lowercase
`owner/name`: `PullRequest`, `PreviewRecipe`, and now `ProjectRepository`.

- Linking a repository to a project picks one from that live list and stores the string.
- A linked repository that drops out of reach stays linked and shows as not reachable.
- A rename on GitHub orphans every row keyed by the old name, project links included.
  This is already true of saved previews and pull requests. The fix, when it matters, is a
  `Repository` row created lazily the first time state attaches to a repository, keyed by
  GitHub's numeric repository id.

### Saved previews

`PreviewRecipe` stays keyed by `(workspaceId, repository)`. The project shows the saved
preview of each of its repositories; it does not own it. A repository in two projects shows
the same recipe in both. A per-project override (an optional `projectId` on
`PreviewRecipe`, preferred over the repository's) waits for a real monorepo case.

## Threads in a project

- **The spec carries the project:** its name, brief, memory, library folder path,
  repositories (as defaults to check out) and preferred connections.
- **Memory gains a fourth kind:** `projects/<id>.md`, beside `workspace.md`,
  `teammates/<id>.md` and `threads/<id>.md`. It loads into every thread in the project.
  When a thread goes quiet, the memory step chooses where each fact goes: the project,
  the teammate or the workspace. A project fact never lands in teammate memory, so a
  teammate does not carry one project's facts into another's threads. A thread without a
  project writes memory as today.
- **Design systems** gain the project as a target. The order becomes: named in the
  message, then folder, repository, **project**, teammate, default.
- **Inheritance.**
  - A thread started from a project page, or from a task, schedule or trigger with a
    project, gets that project.
  - A thread started anywhere else gets none, unless the composer's picker sets one.
- **Moving a thread** to another project, or out of one, sets `projectId`. Its next turn
  gets the new context. Earlier turns and the thread's summary stay as they were.

## Mentions

A project is mentionable like a teammate or a repository: `@[Acme web](project:<id>)`.

- The composer's and the document editor's `@` menus list projects (not archived),
  second after teammates. In messages and documents the chip opens the project page.
- Every thread's spec carries the workspace's projects (`projects`: name, id,
  shortened brief, folder, repositories), and the teammate's instructions list them,
  so a mention of any project can be followed, not only the thread's own.
- Mentioning a project does not move the thread into it: the project picker does.
- Messages from before projects used `project` for a repository, with an
  `owner/name` id. `isLegacyProjectMention` tells them apart by the slash, and
  they still render as repositories.

## Interface

### Sidebar (option B)

```
Support · Acme            ⌄
Search…
Work
  Home
  Tickets
  Threads
  Tasks
  Pull requests
  Library
  Routines
Projects                  +
  A  Acme web
  B  Beta app
AI teammates              +
  Chief
  …
Workspace settings
```

- Work pages stay global, each gaining a project filter that includes "No project".
- Setup pages (Connections, Secrets, Security, AI accounts, Computers) move under
  **Workspace settings**, a collapsible section at the bottom of the sidebar, open
  while one of its pages is showing. They are not about any project.
- The Projects label links to `/app/projects`, which lists every project, the
  archived ones in their own section. Archived projects leave the sidebar.

### Project page

`/app/projects/<id>` replaces today's redirect in `apps/web/app/app/projects/page.tsx`.
The project is highlighted in the sidebar; nothing else in the sidebar changes. It is a
place, not a mode: the global pages stay unfiltered.

Header: icon, name, brief, **New thread** (project preset) and a menu.

| Tab                | URL                  | Shows                                                                                  | Built from                                    |
| ------------------ | -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Overview           | `/app/projects/<id>` | Needs you, running now, open tasks, PRs, repositories and previews, context, this week | New: aggregates from existing endpoints       |
| Threads            | `…/threads`          | The threads list                                                                       | Existing list, `?project=<id>`                |
| Tasks              | `…/tasks`            | The board                                                                              | Existing board, `?project=<id>`               |
| Pull requests      | `…/pulls`            | PRs of its threads and repositories                                                    | Existing list, filtered                       |
| Library            | `…/library`          | The library opened at the project's folder                                             | Existing page with a root path                |
| Repos and previews | `…/repos`            | Each repository, its saved preview, live previews                                      | `SavedPreviews`, filtered to its repositories |
| Routines           | `…/routines`         | Its schedules and triggers                                                             | Existing page, `?project=<id>`                |
| Settings           | `…/settings`         | Name, icon, brief, repositories, folder, preferred connections, archive                | New form                                      |

On the overview:

- **Needs you:** open tickets of the project's threads. It comes first and is hidden
  when nothing is open.
- **Running now:** threads running or waiting, with live previews.
- **Context:** what teammates receive in this project (brief, memory, folder, preferred
  connections), each editable from there.
- **This week:** working time, threads and merged PRs, counted from the logs as caps
  are. It is a report, not a limit.

### Repository page

`/app/pulls/<owner>/<name>` is new. It shows a repository's open PRs and its saved
preview, whether or not the repository is in a project. The project's Repos tab links to
it. Saved previews leave the Computers page: `<SavedPreviews />` comes out of
`apps/web/app/app/computers/page.tsx`, and `docs/previews.md` is updated to match.

### Composer

The new-thread and new-task forms have a project picker, never required. It defaults to
the project the person is in, else "No project".

## From a website

A new project may start from its website. The dialog shows only the address first; once it is
given (pasted, Continue or Enter), each step shows as it runs (reading the site, finding its
logos, writing its name and brief), and the fields appear filled in, to edit. They are not there
while they are being filled, so nothing typed is lost; "Fill it in myself" stops waiting.

- **A first guess** comes from the HTML, read by the API (`src/project-sites.ts`): the name from
  `og:site_name` or the title, the meta description, and the logos the site offers, best first:
  `apple-touch-icon`, the manifest's icons, `<link rel="icon">`, the `<img>` and `<svg>` named
  "logo" or linking to the home page, `og:image`, `/favicon.ico`. Only public HTTPS addresses,
  every redirect checked, a size cap per read.
- **The name, the brief and the logo** come from the member's own account, never another's: the
  API sends the site's text (home page, plus `/about` or `/pricing` when linked) and each logo
  said in words (where it is, its alt, its file) to a runner where the member has an account with
  usage left (`project.describe`, protocol 24). The run uses the harness's small model with no
  tools at all, since the text is a stranger's, and answers in JSON. With no such account or
  computer online, the first guess and the site's description fill in, and the dialog says why.
- **The logo** is shrunk by the dashboard to 256 px at most (some sites serve a 2 MB PNG for a
  28 px logo), kept in the bucket (`project-logos/<projectId>`) and shown instead of the icon
  everywhere; settings can upload another, take it from the website again, or remove it. Deleting
  the project deletes it.

## API

- `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`, archive and unarchive.
  Any member creates and edits a project; it is audited like other workspace changes.
- `PUT /api/projects/:id/repositories`: replaces the list. Only repositories that
  `workspaceRepositories` returns are accepted.
- `GET /api/projects/:id/overview`: the overview's sections in one response.
- `?project=<id|none>` on the threads, tasks, tickets, pull requests, schedules and
  triggers lists.
- `PATCH` on a thread or task accepts `projectId`, so items can be moved.

## Edge cases

- **Archiving a project** keeps its threads, tasks, folder and repository links. Its
  schedules and triggers keep firing; the project page says so, and pausing them is a
  separate action.
- **Deleting a project** sets `projectId` to null on its threads, tasks, schedules and
  triggers, and deletes its repository links and memory file. The library folder and the
  repositories stay.
- **A project folder moved or renamed** in the library updates `Project.folder` in the
  same transaction as the path rewrite.
- **Teammates creating schedules** from a project thread give the schedule that project.
  When the thread moves to another project, its child threads and the schedules reporting
  to it move with it.

## Not now

- Per-project caps, connection access or member visibility. These are signs a workspace
  is needed instead.
- A project scope switcher (option A). It could be added on top: selecting a project
  would scope the work pages until cleared.
- Tags, or an item in several projects.
- A `Repository` table, until renames or per-repository state call for it.
- Per-project saved preview overrides.

## Status

Built in that order (migration `20261012150000_projects`). Checked on a test API
and web build: creating, linking repositories, moving threads and tasks, the
filters, archiving, deleting, and the project's spec, instructions and memory
prompt. Threads that actually ran in a project, and the memory step choosing the
project file in a live run, are not tested yet. Cloud computers get the runner side
(project section, project memory) once the runner bundle is rebuilt.

## Build order

1. Schema and migration: `Project`, `ProjectRepository`, `projectId` columns,
   `project_memory`.
2. API: project CRUD, repository links, the `?project=` filter on lists, moving items.
3. Sidebar: the Projects section, and setup pages moved under Workspace settings.
4. Project page: Overview, then tabs reusing the existing lists.
5. Thread spec and runner: brief, project memory, folder, repositories, preferred
   connections. The memory step chooses the project file.
6. Repository page; saved previews leave Computers.
7. Design system target; schedules and triggers with a project.
