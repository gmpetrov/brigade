# Tools

A **tool** is a small web app a teammate makes and saves in the library: a dashboard for a campaign,
a board to review and approve generated clips, a tracker, a form that feeds a thread. People open it
beside a page or a thread and work in it. Where a design is for looking at, a tool is for doing:
through `window.brigade` it lists library folders, keeps state, calls App accounts people attached
to it, and sends messages to its thread.

Tools are behind the `tools` feature (docs/feature-flags.md) while the team tries them.

## What a member sees

- **Library → Tools**: every tool, newest first, with its picture. In Files, a tool's folder is one
  row ("Tool · …") that opens it; a thread's mention of it opens it beside the thread.
- **The tool's panel**: its page fills the panel (Expand for the whole window). The title's menu
  says who made it and where its messages go, opens it in the library or in a new tab (outside
  Brigade, where its calls fail), and reloads it.
- **Accounts**, when the tool asks for Apps: each App it asks for, the accounts attached for it,
  and those the member may attach. A warning shows on the button while one is missing, or while
  the tool changed since its accounts were attached.
- **Confirmations**: before a tool writes to an App, or sends a message to its thread, Brigade
  asks in a dialog of its own, outside the tool's frame: the operation, the account and its input,
  or the message. Nothing goes unless the person allows it.

## How a teammate makes one

The `brigade-tools` skill (apps/runner/src/instructions.ts), for teammates who can save to the
library in threads whose starter has the feature. A tool is a folder on the teammate's computer:

- `index.html`, its scripts, styles and assets, linked by relative paths;
- `tool.json`: `title`, `description`, `reads` (library folders it lists and loads; its own
  always), `apps` (Apps it calls: `{ kind, access: "read" | "read_write", why }`) and `hosts`
  (public APIs its script calls directly, as https origins). Lenient: a bad entry is left out.

`check_design` renders it like a design, with the bridge added as outside Brigade
(`brigade.inBrigade` false: the tool shows sample data). `save_tool` saves the folder to a library
path ending in `.tool` (with a `thumbnail.png` when Chrome is there) and returns the mention of its
`index.html`, labelled with the folder, which opens the tool. `read_tool_state` gives the teammate a
tool's shared state and the own state of the person the thread works for.

## The bridge

The sandbox host adds a script first in the head of a tool's pages (`toolBridgeScript`,
`@brigade/contracts` tool.ts). It gives the page `window.brigade`:

| Call                                      | What it does                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `me()`                                    | The viewer: `{ memberId, name }`.                                                                             |
| `files.list(folder)`                      | The files of a folder `reads` lists, each with a `url` on the sandbox host (a few hours).                     |
| `state.get/list/set/delete`               | The viewer's own keys; `list(prefix, { after })` gives `{ entries, next }`, about 1 MB of values a page.      |
| `shared.get/list/set/delete`              | Keys shared by everyone who opens the tool; `set(key, value, { version })` writes over the version read only. |
| `apps.list()`, `apps.operations(account)` | The attached accounts, and an account's operations with their input schemas.                                  |
| `apps.call(account, operation, input)`    | Calls an operation (named as the teammate's own tool for it); an account by kind or id.                       |
| `thread.send(text)`                       | Sends a message to the thread, as the viewer, said to come from the tool.                                     |

Each returns a Promise and rejects with an `Error` whose `code` says why when it matters
(`conflict`, `declined`, `tool_changed`, `not_usable`, `no_account`, `no_thread`, `app_error`).

The page talks only to the dashboard around it: its origin is opaque, it has no cookies, and its
CSP lets it call nothing of the API (`toolCsp`). As it runs, the bridge opens a `MessageChannel` of
its document's own and sends the dashboard one end, with the key the host wrote into the script for
the tool's address (`bridgeKey`, which the dashboard gets with the view). A frame keeps its window
when it navigates, so a check on the window alone would let a site the tool links to inherit the
bridge: without the key, no channel opens. Calls and answers go over that channel only, so an answer
never reaches a document that replaced the page; the page says `bye` as it goes, and what it was
waiting for (a question to the person included) is dropped. The dashboard
(`components/tool-view.tsx`, `lib/tool-host.ts`) checks each call again and makes it with the
person's session (`/api/tools/*`).

## Decisions

- **A tool is a library folder, served like a design.** Same sandbox origin (`DESIGN_URL`), same
  kind of signed four-hour address, under `/t/<token>/` with a key of its own (a design's address
  never opens a tool). Library files it reads are under `/t/<token>/_library/<path>`, only in the
  folders it declares, served never to run (`content-security-policy: sandbox`); video and large
  files from the bucket's own address. No hosted backend: a tool is a page, its data is Brigade's.
- **State is not a library file.** Each save of a library file is a new version, and two people
  saving one file overwrite each other. `ToolState` keeps a key's JSON per tool (by its
  `index.html` document, so it follows the tool when it moves) and per owner: `shared`, or a
  member. A write over a version is one conditional statement; a key that changed meanwhile answers
  409 with what is there now. A deleted key stays as a tombstone, one version on, so a write over
  a version read before it was deleted (and made again) is refused too. Up to 100 KB a value and
  2000 keys an owner. A listing reads the values' sizes first and only as many values as fit in
  about 1 MB (a page, with `next`): an API isolate has 128 MB in all. Viewers keep their own state
  and read the shared; they change nothing everyone sees.
- **Apps through operations, not a proxy.** A tool calls an attached account's operations by name,
  the same catalog teammates use (`grantOperations`, `connectors`, `mcpOperation`), never a URL with
  a token added. Brigade knows which operations write, and no credential ever reaches the page.
  Operations that send files, and Brigade's own Apps (Email), are not available to tools.
- **Attaching an account is giving it.** Every member who may use the account can then call it
  through the tool, so attaching follows giving an account to a teammate: its owner, or an owner or
  admin for a shared one; a personal account only by its owner. Calls follow using an account in a
  thread: a shared account for every member (not viewers), a personal one for its owner only.
- **A changed tool asks again.** An attachment keeps the hash of the tool's files (its picture
  aside). Once a save changes them, the tool's code may do something else than what the person who
  attached the account saw: its calls are refused (`tool_changed`) until a member who may attach the
  account allows the tool again. This is the guard against a tool's script being changed to send an
  account's data elsewhere: a sandboxed page can always load an image from anywhere, so the CSP is
  not one. So that the hash is the code that runs, scripts come only from the tool's own address
  (`script-src` its `/t/<token>/` path, and scripts written in its pages): no script from a CDN,
  which can change without the tool changing, no `eval`, no script from a `blob:` or `data:`
  address. Library files it reads, under the same path, are never served as a script type (with
  `nosniff`, a browser refuses to run them). A tool's own code can still build a script from text
  it fetched on purpose: that is in the hashed code, for the person allowing it to see.
- **Writes and messages wait for the person.** A write needs a `read_write` attachment and the
  person's confirmation in the dashboard's own dialog (`confirmed`, which only the dashboard sends:
  the page cannot reach the API). A message to the thread too. Reads go without asking: what the
  page shows is what the person opened it for.
- **Limits.** 120 App calls a minute for each member through tools (in each API process). Writes
  through a tool, and attaching, taking off and allowing accounts, are in the audit log
  (`tool.app_write`, `tool.account_attached`, `tool.account_detached`, `tool.change_allowed`).
- **Not yet.** A vault credential for an API without an App (a proxy that adds a key only for its
  base URL), a tool's own AI calls (the teammate is its AI: the tool sends to the thread), and
  sharing a tool through a public link (its bridge would have no person behind it).

## Where it is

- Contracts: `packages/contracts/src/tool.ts` (manifest, requests, bridge script).
- API: `apps/api/src/tools.ts` (views, state, files, accounts, calls, the sandbox host's `/t/`),
  `apps/api/src/routes/tools.ts` (`/api/tools/*`, behind the feature), `ToolState` and
  `ToolAccount` (`prisma/schema.prisma`), `tool_state` in `src/library-calls.ts`.
- Runner: `save_tool`, `read_tool_state` (`apps/runner/src/harness/tools.ts`), the skill and
  section (`apps/runner/src/instructions.ts`), the bridge in `check_design` (`src/design-shot.ts`).
- Dashboard: `components/tool-view.tsx`, `lib/tool-host.ts`, `components/tool-gallery.tsx`, and
  tools in `components/library-browser.tsx` and `components/file-panel.tsx`.
- Sample: the Acme workspace's `Projects/Fall launch/visual-review.tool` (`prisma/seed-tool.ts`).
- Tests: `apps/api/test/tools.test.ts`, `apps/web/test/tool-host.test.ts`,
  `apps/runner/test/save-tool.test.ts`, `packages/contracts/test/tool.test.mjs`.
