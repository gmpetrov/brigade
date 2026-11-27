# Apps

An **app** is a small web app a teammate makes and saves in the library: a dashboard for a campaign,
a board to review and approve generated clips, a tracker, a form that feeds a thread. People open it
beside a page or a thread and work in it. Where a design is for looking at, an app is for doing:
through `window.brigade` it lists library folders, keeps state, calls App accounts people attached
to it, and sends messages to its thread.

Apps are behind the `apps` feature (docs/feature-flags.md) while the team tries them.

## Names

Apps were called tools until 27 Nov 2026; the code still calls them tools (`ToolView`, `ToolState`,
`tool-view.tsx`, `toolFolderOf`), since `App` there already names connected apps (the `App`
model, `/api/connections/apps`). What people and teammates see says app:

- An app is a library folder named `<name>.webapp` with `app.json`. A folder named `<name>.tool`
  with `tool.json`, saved before the rename, still opens as one, and `save_app` saves to it again
  under its old path, so its state and attached accounts stay (both keyed by its `index.html`).
  The folder's suffix says which manifest it has (`toolManifestFile`): `app.json` for
  `.webapp`, `tool.json` for `.tool`. The other file, if one is there, is just a file, so an app
  never has two manifests that disagree. `save_app` writes that one only, from either file of the
  teammate's folder.
  Not `.app`: Finder takes a folder so named for an application (the library's copies are on
  Macs), and `.app` is also a domain ending people name folders with.
- Teammates save one with `save_app` and read its state with `read_app_state`, following the
  `brigade-apps` skill. The thread spec still carries the feature as `tools`.
- The feature is `apps`: a migration copied the `tools` row, which stays for the API before it.
  The dashboard takes either.
- The API answers under `/api/apps/*` and, for dashboards from before the rename, `/api/tools/*`.
- In the dashboard, the integrations people connect (App accounts) show as **Connected apps**, so
  that **Apps** names these. "App" with a capital in this document means a connected app.

## What a member sees

- **Library → Apps**: every app, newest first, with its picture. In Files, an app's folder is one
  row ("App · …") that opens it. From the library, an app opens in the document panel, as a
  Markdown document does: it stays open from page to page, and Minimize (⌄, ⌘.) folds it into
  the panel's round button, its page kept as it was. A thread's mention of it opens it beside
  the thread.
- **The app's panel**: its page fills the panel (Expand for the whole window). The title's menu
  says who made it and where its messages go, opens it in the library or in a new tab (outside
  Brigade, where its calls fail), and reloads it.
- **Kept while away**: an app beside a thread stays loaded, hidden, while another thread shows,
  as a thread's preview does (`apps/web/components/kept-previews.tsx`): back on the thread, its
  page is as it was left (what was typed, where it was scrolled), not loaded again. The latest
  three hidden ones are kept; one closed, or replaced by another file beside its thread, goes. A
  app minimized in the document panel is kept hidden the same way until it is back.
- **Ask <teammate>**, outside a thread: talks about the app as about any library file, in the
  thread that saved it last when the member may write there, else in a new thread with the
  teammate that saved it; the reply box holds the app's mention. On a wide screen the app moves
  to the document panel first, so it stays beside that thread.
- **Select an element** (the pointer button, once the page says it can): as in a thread's preview
  (docs/previews.md), a click on an element of the app puts it in a thread's reply box, with its
  picture, for the person to say what should change there and send it with their other edits. It
  goes to the thread the app is beside, else, in the document panel, to the thread open last
  (`apps/web/lib/element-pickers.ts`); with none open, the button opens the app's thread first,
  as Ask does, when the person may write there. Otherwise it does not show: a new thread's
  composer takes no elements until its first message is sent. Its `page` is the app's file in the library (`<folder>/index.html`), never the
  page's address, which carries its token. The sandbox host adds the same script as the preview's
  proxy to the app's pages, after the bridge (`elementSelectScript` in contracts'
  `element-select.ts`), and serves modern-screenshot under the app's own address
  (`/t/<token>/__brigade/screenshot.mjs`, from `src/generated/screenshot.ts`), the only place its
  scripts may come from. The page's origin is opaque, so the library cannot read default styles
  from a frame of its own: it writes every style out instead.
- **Its mention** opens the app, wherever it is clicked: in a message, the reply box or a
  document. The document panel shows an app's folder, or its `index.html`, as the app.
- **Accounts**, when the app asks for Apps: each App it asks for, the accounts attached for it,
  and those the member may attach. A warning shows on the button while one is missing, or while
  the app changed since its accounts were attached.
- **Confirmations**: before an app writes to an App, or sends a message to its thread, Brigade
  asks in a dialog of its own, outside the app's frame: the operation, the account and its input,
  or the message. Nothing goes unless the person allows it.

## How a teammate makes one

The `brigade-apps` skill (apps/runner/src/instructions.ts), for teammates who can save to the
library in threads whose starter has the feature. An app is a folder on the teammate's computer:

- `index.html`, its scripts, styles and assets, linked by relative paths;
- `app.json`: `title`, `description`, `reads` (library folders it lists and loads; its own
  always), `apps` (Apps it calls: `{ kind, access: "read" | "read_write", why }`) and `hosts`
  (public APIs its script calls directly, as https origins). Lenient: a bad entry is left out.

`check_design` renders it like a design, with the bridge added as outside Brigade
(`brigade.inBrigade` false: the app shows sample data). `save_app` saves the folder to a library
path ending in `.webapp` (with a `thumbnail.png` when Chrome is there) and returns the mention of its
`index.html`, labelled with the folder, which opens the app. `read_app_state` gives the teammate an
app's shared state and the own state of the person the thread works for.

## The bridge

The sandbox host adds a script first in the head of an app's pages (`toolBridgeScript`,
`@brigade/contracts` tool.ts). It gives the page `window.brigade`:

| Call                                      | What it does                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `me()`                                    | The viewer: `{ memberId, name }`.                                                                            |
| `files.list(folder)`                      | The files of a folder `reads` lists, each with a `url` on the sandbox host (a few hours).                    |
| `state.get/list/set/delete`               | The viewer's own keys; `list(prefix, { after })` gives `{ entries, next }`, about 1 MB of values a page.     |
| `shared.get/list/set/delete`              | Keys shared by everyone who opens the app; `set(key, value, { version })` writes over the version read only. |
| `apps.list()`, `apps.operations(account)` | The attached accounts, and an account's operations with their input schemas.                                 |
| `apps.call(account, operation, input)`    | Calls an operation (named as the teammate's own app for it); an account by kind or id.                       |
| `thread.send(text)`                       | Sends a message to the thread, as the viewer, said to come from the app.                                     |

Each returns a Promise and rejects with an `Error` whose `code` says why when it matters
(`conflict`, `declined`, `tool_changed`, `not_usable`, `no_account`, `no_thread`, `app_error`).

The page talks only to the dashboard around it: its origin is opaque, it has no cookies, and its
CSP lets it call nothing of the API (`toolCsp`). As it runs, the bridge opens a `MessageChannel` of
its document's own and sends the dashboard one end, with the key the host wrote into the script for
the app's address (`bridgeKey`, which the dashboard gets with the view). A frame keeps its window
when it navigates, so a check on the window alone would let a site the app links to inherit the
bridge: without the key, no channel opens. Calls and answers go over that channel only, so an answer
never reaches a document that replaced the page; the page says `bye` as it goes, and what it was
waiting for (a question to the person included) is dropped. The dashboard
(`components/tool-view.tsx`, `lib/tool-host.ts`) checks each call again and makes it with the
person's session (`/api/tools/*`).

## Decisions

- **An app is a library folder, served like a design.** Same sandbox origin (`DESIGN_URL`), same
  kind of signed four-hour address, under `/t/<token>/` with a key of its own (a design's address
  never opens an app). Library files it reads are under `/t/<token>/_library/<path>`, only in the
  folders it declares, served never to run (`content-security-policy: sandbox`); video and large
  files from the bucket's own address. No hosted backend: an app is a page, its data is Brigade's.
- **State is not a library file.** Each save of a library file is a new version, and two people
  saving one file overwrite each other. `ToolState` keeps a key's JSON per app (by its
  `index.html` document, so it follows the app when it moves) and per owner: `shared`, or a
  member. A write over a version is one conditional statement; a key that changed meanwhile answers
  409 with what is there now. A deleted key stays as a tombstone, one version on, so a write over
  a version read before it was deleted (and made again) is refused too. Up to 100 KB a value and
  2000 keys an owner. A listing reads the values' sizes first and only as many values as fit in
  about 1 MB (a page, with `next`): an API isolate has 128 MB in all. Viewers keep their own state
  and read the shared; they change nothing everyone sees.
- **Apps through operations, not a proxy.** An app calls an attached account's operations by name,
  the same catalog teammates use (`grantOperations`, `connectors`, `mcpOperation`), never a URL with
  a token added. Brigade knows which operations write, and no credential ever reaches the page.
  Operations that send files, and Brigade's own Apps (Email), are not available to apps.
- **Attaching an account is giving it.** Every member who may use the account can then call it
  through the app, so attaching follows giving an account to a teammate: its owner, or an owner or
  admin for a shared one; a personal account only by its owner. Calls follow using an account in a
  thread: a shared account for every member (not viewers), a personal one for its owner only.
- **A changed app asks again.** An attachment keeps the hash of the app's files (its picture
  aside). Once a save changes them, the app's code may do something else than what the person who
  attached the account saw: its calls are refused (`tool_changed`) until a member who may attach the
  account allows the app again. This is the guard against an app's script being changed to send an
  account's data elsewhere: a sandboxed page can always load an image from anywhere, so the CSP is
  not one. So that the hash is the code that runs, scripts come only from the app's own address
  (`script-src` its `/t/<token>/` path, and scripts written in its pages): no script from a CDN,
  which can change without the app changing, no `eval`, no script from a `blob:` or `data:`
  address. Library files it reads, under the same path, are never served as a script type (with
  `nosniff`, a browser refuses to run them). An app's own code can still build a script from text
  it fetched on purpose: that is in the hashed code, for the person allowing it to see.
- **Writes and messages wait for the person.** A write needs a `read_write` attachment and the
  person's confirmation in the dashboard's own dialog (`confirmed`, which only the dashboard sends:
  the page cannot reach the API). A message to the thread too. Reads go without asking: what the
  page shows is what the person opened it for.
- **Limits.** 120 App calls a minute for each member through apps (in each API process). Writes
  through an app, and attaching, taking off and allowing accounts, are in the audit log
  (`tool.app_write`, `tool.account_attached`, `tool.account_detached`, `tool.change_allowed`).
- **Not yet.** A vault credential for an API without an App (a proxy that adds a key only for its
  base URL), an app's own AI calls (the teammate is its AI: the app sends to the thread), and
  sharing an app through a public link (its bridge would have no person behind it).

## Where it is

- Contracts: `packages/contracts/src/tool.ts` (manifest, requests, bridge script).
- API: `apps/api/src/tools.ts` (views, state, files, accounts, calls, the sandbox host's `/t/`),
  `apps/api/src/routes/tools.ts` (`/api/tools/*`, behind the feature), `ToolState` and
  `ToolAccount` (`prisma/schema.prisma`), `tool_state` in `src/library-calls.ts`.
- Runner: `save_app`, `read_app_state` (`apps/runner/src/harness/tools.ts`), the skill and
  section (`apps/runner/src/instructions.ts`), the bridge in `check_design` (`src/design-shot.ts`).
- Dashboard: `components/tool-view.tsx`, `lib/tool-host.ts`, `components/tool-gallery.tsx`, and
  apps in `components/library-browser.tsx` and `components/file-panel.tsx`.
- Sample: the Acme workspace's `Projects/Fall launch/visual-review.webapp` (`prisma/seed-tool.ts`).
- Tests: `apps/api/test/tools.test.ts`, `apps/web/test/tool-host.test.ts`,
  `apps/runner/test/save-tool.test.ts`, `packages/contracts/test/tool.test.mjs`.
