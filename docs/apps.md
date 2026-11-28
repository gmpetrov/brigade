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
  `.webapp`, `tool.json` for `.tool`. A file of the other name is just a file of the app (data it
  loads, say), so an app never has two manifests that disagree. The code hash its accounts are
  attached under says which file is the manifest (as before for `.tool` folders, so what was
  allowed stays allowed): a `.tool` folder moved to `.webapp` waits to be allowed again.
  `save_app` saves every file as it is, and a `.webapp`'s `tool.json` as its `app.json` too when
  it has no `app.json`.
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
| `badge.set(count)`, `badge.clear()`       | The app's count on its own icon, once installed on a Mac (below); `{ shown }` says whether it shows.         |

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

## Installed apps

In Brigade.app (apps/desktop), an app can be installed on the computer, so that it opens in a window
of its own, from an icon of its own, as Chrome's installed web apps and Claude's installed
artifacts do. Behind the `apps` feature, like apps themselves. Not in a browser: a web install (a
PWA manifest per app) is a separate change.

- **What a member sees.** The app's title menu (`components/tool-view.tsx`) has **Install on this
  computer**, in Brigade.app's dashboard window only, when its bridge has `apps` (an older
  Brigade.app shows nothing). Brigade.app asks first, in its own dialog ("Install “Clip review”
  as an app?"), then opens the app. Once installed, the menu has **Open in its own window** and
  **Uninstall from this computer** instead.
- **The window** shows the dashboard's `/app/apps/window?path=<folder>&id=<index.html id>&workspace=<id>`
  (`app/app/apps/window/page.tsx`): the app alone (`ToolWindow`), its Accounts button and the
  confirmations, without the panel's Ask, Select, library link or minimize. It loads in Brigade.app's
  own session: no second sign-in. It finds the app by its document id, so an app moved in the
  library still opens; a deleted one says so. An app from another workspace than the one shown
  switches the session to it (`?workspace=`, as a notification does), which the dashboard window
  then shows too. The window stays on that page: any other dashboard address opens in the
  dashboard window, a signed-out page included.
- **Its bridge** (`preload.ts`) has `info` (`window: 'app'`) and `apps.setBadge` only: no
  captures, no sign-in, no notifications, no computer use (`ipc.ts` refuses them to an app
  window). The dashboard there behaves as in a browser (`desktopBridge()` is undefined;
  `appWindowBridge()` gives the badge).
- **The icon** is drawn by the dashboard (`lib/desktop-apps.ts`): the app's `thumbnail.png`
  cropped to a square, or a gradient of its own with the title's first letter, in a rounded
  square (with macOS's margin on a Mac), 1024px. Brigade.app reads it as an image and writes each
  system's format.
- **Names.** The title as a file name every system takes; " (<workspace>)" when an app of that
  name from another workspace is installed; " (App)" when it would pass for Brigade's, Apple's,
  Microsoft's or a system app; " 2", " 3"… when the name is taken. Nothing is written over.
- **What Brigade.app keeps**: `installedApps` in `~/.brigade/desktop.json` (`installed-apps.ts`):
  for each install a random install id (16 bytes, hex), the app's document id and folder, its
  workspace, the path of what was written, the bundle's cdhash on macOS and the icon's path on
  Windows and Linux. A bundle, shortcut or entry deleted by hand is forgotten the next time the
  list is read.

### macOS: an app shim

Electron 45's app shims (`app.startAppShimServer`, `AppShimHost`, `BrowserWindow({ appShim })`,
marked experimental), as Chrome and Claude use (`app-install-mac.ts`, `app-windows.ts`):

- `~/Applications/Brigade Apps/<name>.app`: `Contents/MacOS/app` is a copy of Electron's
  `app_shim_loader` (`Electron Framework.framework/Versions/A/Helpers/`), its Info.plist names the
  install (`BrigadeAppInstallId`, bundle id `ai.brigade.desktop.app.<installId>`) and Brigade.app
  (`ElectronAppShimHostPath`, `ElectronAppShimHostBundleIdentifier`, `ElectronAppShimServerName`
  `brigade-apps`, `ElectronAppShimHostArguments` `--app-shim`), its icon is an .icns made with
  `sips` and `iconutil`. It is made in Brigade.app's own folder, signed ad hoc on the Mac
  (`codesign --sign -`, its cdhash kept), then moved in under a name claimed first, registered with
  Launch Services and opened. The folder is refused when it is a link or someone else's.
- Launched, the shim loads Brigade.app's framework and connects to it, starting it first if it is
  closed: Brigade then starts with `--app-shim`, without its own window or Dock icon until one of
  its own windows opens (`startHidden`). Brigade.app gives a window only to a shim whose bundle
  names a known install and whose running process has that install's cdhash
  (`satisfiesCodeRequirement('cdhash H"…"')`, which binds its Info.plist too); any other is told
  to quit. Any process of the account can connect to the server, so nothing opens without both.
- The window is made in the shim's process: its own Dock icon, ⌘-Tab entry, menu bar (the app's
  name with Open in Brigade, Uninstall…, Hide and Quit; Edit; View; Window) and badge
  (`brigade.badge.set`). Closing the window quits the shim; its Dock icon, clicked, opens it again.
- Updates keep Brigade.app's path, so shims keep working. A Brigade.app that moved rewrites each
  shim's host path at start and signs it again. A shim launched after Brigade.app was updated
  while running cannot connect (`app-shim-version-mismatch`): Brigade offers to restart.

### Windows: a Start menu shortcut

`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Brigade Apps\<name>.lnk`
(`app-install-win.ts`): Brigade's executable with `--app=<installId>`, an .ico of 16 to 256px
(PNG entries, `encodeIco`) and the AppUserModelID `ai.brigade.desktop.app.<installId>`. Launched
with Brigade closed, Brigade starts without its own window; running, `second-instance` gets the
argument. The window gets the same id and the relaunch command (`setAppDetails`), so the taskbar
gives it its own button, with its icon, which pins and relaunches the app. A Brigade that moved
rewrites the shortcuts' target at start.

### Linux: a launcher entry

`~/.local/share/applications/brigade-app-<installId>.desktop` (`app-install-linux.ts`): Exec runs
the AppImage (`$APPIMAGE`) or Brigade's binary with `--app=<installId>`, Icon is the app's PNG in
Brigade's own folder, `StartupWMClass=brigade-app-<installId>`. Rewritten at each start, since an
AppImage's path changes with updates. On X11 the window's `WM_CLASS` is set to match before it is
shown (through the `x11` package), so the dock groups it under its own icon. On Wayland a window
can't be given its own app id: it groups under Brigade's icon, and its launcher entry still opens
it. No badge on Windows and Linux (`badge.set` answers `{ shown: false }`).

### Uninstall

From the app's menu in the dashboard, or Uninstall… in its own menu on macOS, after Brigade.app
asks. Only what the list names is removed, after checking it is Brigade's: a bundle in the apps
folder whose `BrigadeAppInstallId` matches, a shortcut in the Brigade Apps folder whose arguments
name the install, an entry of Brigade's whose `X-Brigade-App-Install-Id` matches.

### Checked

Unit tests (`apps/desktop/test/installed-apps.test.ts`): the list, `--app=`, names and imitation
names, the Info.plist and its escaping (read back by `plutil` on macOS), the `.ico`, the desktop
entry's quoting (and `desktop-file-validate` on Linux). The packaged app's smoke test
(`test/e2e/smoke.mjs`, CI on the three systems) installs an app through the bridge, checks what
was written (the signed shim and its plist; the shortcut read back; the entry validated), the app
window's bridge, and uninstalls.

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
  apps in `components/library-browser.tsx` and `components/file-panel.tsx`; installing,
  `lib/desktop-apps.ts` and `app/app/apps/window/page.tsx`.
- Brigade.app: `apps/desktop/src/app-windows.ts`, `installed-apps.ts`, `app-install-mac.ts`,
  `app-install-win.ts`, `app-install-linux.ts`.
- Sample: the Acme workspace's `Projects/Fall launch/visual-review.webapp` (`prisma/seed-tool.ts`).
- Tests: `apps/api/test/tools.test.ts`, `apps/web/test/tool-host.test.ts`,
  `apps/desktop/test/installed-apps.test.ts`,
  `apps/runner/test/save-tool.test.ts`, `packages/contracts/test/tool.test.mjs`.
