# Development

The [README](../README.md#run-it-locally) has the short version. This page has the details: running threads on your
machine, Brigade.app and computer use on macOS and Linux, and the dashboard's theme.

## Set up

Requires Node.js 24 (`.nvmrc`), pnpm and Docker (for the local PostgreSQL).

```bash
pnpm install
docker compose up -d                       # PostgreSQL on localhost:5433
cp apps/api/.env.example apps/api/.env     # then set BETTER_AUTH_SECRET
pnpm --filter @brigade/api db:migrate      # apply migrations
cp apps/collab/.dev.vars.example apps/collab/.dev.vars   # optional: COLLAB_SECRET, the same as in apps/api/.env
pnpm dev                                   # api :3001, web :3000, collab :8787, package watchers
```

Open http://localhost:3000, create an account, an organization and a workspace, then a teammate.

Without Docker, or for a preview in a Brigade thread: `scripts/preview/setup.sh`, then `scripts/preview/start.sh` (see [AGENTS.md](../AGENTS.md)).

## Run threads on your machine

In the dashboard, open **Computers → Get a link code**, then in a shell where `claude` is signed in:

```bash
pnpm --filter @brigade/runner build
node apps/runner/dist/index.js link <CODE> --api http://localhost:3001
node apps/runner/dist/index.js start
```

The runner keeps its token, event outbox and harness state in `~/.brigade` (override with `BRIGADE_HOME`).
It strips `ANTHROPIC_*` and other API-key variables at startup, so Claude Code runs on your subscription login.
Only one runner runs per home: `start` claims `runner.pid` and exits with code 3 while another holds it.

## Brigade.app and computer use (macOS)

Brigade.app is an Electron app (`apps/desktop`, see its README) for macOS, Linux and Windows: the runner below
everywhere (on Windows from the API's `install.ps1`, see docs/windows.md), the dashboard in a window of its own and
the new thread window.

Members link a Mac with **Brigade.app** (`apps/desktop`) instead of the terminal: **Computers → Link this Mac →
Open in Brigade** opens a `brigade://link?code=…&api=…` link, the app asks before connecting, runs the API's
`install.sh` (Node.js and the runner, as the command does), links the runner and keeps `brigade-runner start`
running from the menu bar. The runner still updates itself from the API's bundle; the app updates itself from
GitHub Releases (`apps/desktop/release`). Logs: `~/.brigade/logs/runner.log`.

A Mac can be linked to several workspaces and runs for one at a time, picked in the menu's **Workspace** submenu
(`apps/desktop/src/workspaces.ts`). Each has a runner home of its own, since a home holds a workspace's
link, outbox, library mirror and thread folders: the first one linked keeps `~/.brigade`, the others get
`~/.brigade/workspaces/<key>`, and all share the runner install in `~/.brigade`. The app starts the runner with
`BRIGADE_HOME` set to the chosen home, named in `~/.brigade/active-workspace`. The dashboard's link names its
workspace (`&workspace=…`): one already linked here is linked again in its own home, keeping its computer, and
another gets a new home. Switching stops the runner, which saves its threads, and starts the other workspace's.

Inside it, **Brigade Computer Use.app** (`apps/computer-use-macos`) gives teammates `computer_screenshot`,
`computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag`, `computer_move`,
`computer_apps`, `computer_open_app`, `computer_ui_tree` and `computer_run` on the member's Mac, and
`computer_snapshot` and `computer_act` through agent-desktop (below). The runner starts it with `open`,
so macOS gives Screen Recording and Accessibility to it, not to Brigade.app or a terminal, and talks to it over a
token-checked socket in `~/.brigade/computer-use`. While a teammate acts, a pill shows its name with a Stop button
(no Esc shortcut); Stop ends computer use for that turn. `computer_key` and `computer_type` take the app they are
for. Text goes into the app's one focused field that takes text, from behind, through agent-desktop (`macAppInput`:
`type` into it, found with `find --state focused`; AppKit marks a list's cells focused too), and nothing when there is
none or several. A key for a named app is checked and sent by Brigade Computer Use in one go (`key` with `app`,
helper version 3, on its main actor): only if that app is in front at that moment, as the keyboard's key, so it reaches
the app's Open and Save panels too, which run in a process of their own; nothing is sent otherwise (`not_front`). A key
to the app's own process (`press --app`) never reached those panels (Cmd+Shift+G and Return in TextEdit's save sheet
did nothing); it is still how a key goes with an older helper, and the answer says what it misses. Without an app they go to the app in front, as before, and the answer names it (`front`). An app behind others
takes no key (its menus, which shortcuts go through, are off: Cmd+S to TextEdit behind Chrome did nothing), so a key
for one is refused, unless `front: true` brings it forward first (taking the person's focus). `computer_open_app`
answers once a window of the app is there (agent-desktop's `list-windows`, up to 5 seconds, then 300 ms for it to
finish opening), with its windows: a snapshot taken at once read a panel still opening, or no window.

Commands in a teammate's own shell don't get those permissions: macOS asks the app responsible for a process, the
one that started it, and for the runner's commands that is Brigade.app, which holds neither. `computer_run` has the
helper start the command instead (`Run.swift`), so a CLI that needs them (agent-desktop, `osascript` with System
Events, a screen recorder) gets them, while the pill shows with Stop. One runs at a time: the runner's commands wait
their turn in a line (`Line` in `apps/runner/src/computer-use.ts`, two minutes at most) rather than meet the helper's
`busy`. The helper looks at the command every 10 ms for its first two seconds, then every 200 ms. When it ends, times out (120
seconds by default, 30 minutes at most), the person presses Stop or the turn is interrupted (`cancel`), the helper
stops the command's shell (by pid, even if it left its group), its process group and every other process macOS counts
the helper responsible for, which a process keeps when it detaches (`setsid`, a double fork); it spares only the
children the helper registers as its own (`screencapture`). That happens before
the reply, and when the helper quits. `swift test` in `apps/computer-use-macos` checks the command's life;
`scripts/test-sweep.sh` checks the sweep in an app opened with `open`, as the helper is (a test process belongs to
the terminal's app, so it has nothing to sweep).

### Apps by accessibility refs: agent-desktop

`computer_snapshot` and `computer_act` read an app's interface as a tree whose elements have refs, then act on a ref
(click, type, set a value, select, toggle, expand, scroll…) through the OS's accessibility API, without moving the
pointer or taking the keyboard focus. They run [agent-desktop](https://github.com/vercel-labs/agent-desktop), which
the runner's bundle doesn't carry: its binaries for every platform took the bundle past the 25 MiB a Worker asset may be
(the API serves it as one), and `bundle.sh` now fails past 24 MiB. A runner downloads the version pinned in
`apps/runner/src/agent-desktop.ts` from npm the first time a teammate uses it, checks it against the integrity pinned
there (the lockfile's, which a test compares), and keeps only its own platform's binaries beside the runner
(`<install dir>/agent-desktop/<version>`, which a runner update leaves and a cloud computer's teammate users can run).
In the repository, the devDependency's copy is used. The tree goes back as text, an element a line (`renderTree`),
kept small since the model reads it again at every later step of the turn: without hidden elements, a run of three or
more siblings scrolled out of view as one line, an element's first 25 children then a line for the rest (all of
them when the snapshot is rooted on it), and cut at 15 KB. The tools are in
`apps/runner/src/harness/desktop-tools.ts`.

`computer_act` takes one action or `steps`, done in order. Actions without text go in agent-desktop's `batch`, one
process for many, stopping at the first refusal; text (`type`, `set_value`) never goes in a batch, whose JSON is on
the command line, but through stdin one action at a time. After acting it reads again what the ref's snapshot read
(its app, the one it actually read when none was named, window and surface; not as a skeleton), in the same batch
after 300 ms, or the menu, sheet or alert the last action opened, and answers with it in `after`: the new refs,
without another call. A small window's (a tree under 6,000 characters) is read again with its text too (`all`), since
a result often shows as text alone (Calculator's). A ref from a snapshot the tool didn't take in this turn gets no
`after`, and the answer says to take one. A menu bar (`surface: menubar`) is read as its menus and items, without the
Apple menu (the system's Restart, Shut Down and Log Out, and the person's recent items) and with each submenu folded
with its count (an app's Open Recent lists file names): rooted on an item, all of it. A
rooted read (`root`) drops `surface`, which agent-desktop refuses beside it, and says its refs are new: a drill
renumbers its region's refs in the same snapshot. Plain siblings of one role in a row (nothing shown but their role: a ruler's markers)
are one line. An action that closed the window it read answers `closed` rather than a snapshot to
take.

- **On a Mac**, beside the tools above, agent-desktop runs through Brigade Computer Use's `run`, so it gets the
  helper's Accessibility; its answer, and any text to type, go through files, never on its command line. `headed:
true` lets an action use the real keyboard and mouse where accessibility doesn't take it. Commands run with
  `computer_run` find the same copy as `agent-desktop`, unless the person has their own on their PATH.
- **On a cloud computer**, a teammate reads and uses its own browser's windows: Chrome's own interface (a permission
  prompt, a sign-in dialog, a bubble, its menus), which the browser tools, made for web pages, don't reach. The
  helper's `browser` starts each teammate's own session bus in `/run/brigade-a11y/<user>` with its Chrome, whose
  accessibility bus carries only that teammate's apps, and starts Chrome with `AT_SPI_BUS_ADDRESS` and
  `ACCESSIBILITY_ENABLED=1` (Chrome turns its pages' accessibility on only once something reads them). The runner
  runs agent-desktop as the teammate on display `:0` and that bus (`desktop.ts`), from outside the thread's
  namespaces. With no window named, `computer_snapshot` reads the browser window in front and lists the others. A
  field that takes no text through accessibility (Chrome's own) gets it from the desktop's keyboard (`xdotool`, as
  the teammate, into its window, class `brigade-<user>`), and so does `computer_key`: agent-desktop matches X windows
  by title, and the helper names each browser's window after its teammate, so it can't bring one to the front. A
  browser started before the helper had the bus is read after its next start.

```bash
pnpm --filter @brigade/computer-use-macos install:app   # helper only, into ~/Applications (runner finds it there)
pnpm --filter @brigade/desktop build:app                 # Brigade.app and its .dmg, with the helper inside
```

### Computer use on Linux

On a member's Linux desktop, **Brigade.app itself** answers the runner's computer-use requests
(`apps/desktop/src/linux`), on the same socket, token and protocol as Brigade Computer Use.app (version 3), so the
runner's tools are the same; it writes its executable to `~/.brigade/computer-use/app`, which the runner starts
with `--computer-use` when nothing answers. The runner offers the tools there once Brigade.app has been opened, or
when it runs in a desktop session (`DISPLAY` or `WAYLAND_DISPLAY`): a server linked with the command gets none.

- **Pointer and keyboard**: XTEST on X11 (the `x11` package, pure JavaScript; a character the layout lacks goes on a
  spare keycode for the time of the call, as xdotool does), and GNOME's own RemoteDesktop D-Bus API on Wayland
  (`mutter.ts`, with one screen-cast stream per monitor to place the pointer). Mutter drops keysyms the layout lacks,
  read from XWayland's keymap: those go through Ctrl+Shift+U and the code (GTK and IBus). Other Wayland desktops let
  no app send input: those requests answer `not_supported`, and teammates use `computer_snapshot` and
  `computer_act`.
- **Screenshots**: Chromium's capturer on X11; the desktop portal on Wayland (asked once, then remembered), cropped
  to the display and scaled to screen points. The pill is hidden while one is taken.
- **The pill**: a window of a second Brigade process (`--brigade-indicator`) on X11, through XWayland on Wayland,
  where a native window can neither place itself nor stay above others.
- **Apps and their interface** (`apps`, `open_app`, `ui_tree`, `key` for a named app): agent-desktop, the runner's
  copy, whose path comes with each request. `run` runs `bash -c` in the person's session, its process group stopped
  on Stop, an interrupted turn or its timeout.

`apps/desktop/test/e2e/linux-sessions.sh` runs the packaged app in a throwaway X11 session (Xvfb with Mutter) and
GNOME on Wayland (headless gnome-shell), and checks each request's effect on GNOME Calculator and Text Editor; CI
runs the X11 one (`.github/workflows/desktop.yml`).

Both sign with the first "Developer ID Application" identity in the keychain (or `BRIGADE_SIGN_IDENTITY`), else ad
hoc, in which case macOS asks for the helper's permissions again after each rebuild. To try Brigade.app without
touching your real runner, run its binary with `BRIGADE_HOME` set to another folder.

## Public docs

The user docs at [www.brigade.lol/docs](https://www.brigade.lol/docs) are a Mintlify site in `apps/docs`
(`docs.json`, one `.mdx` file per page). Mintlify builds it from `main` and hosts it at `brigade.mintlify.site`;
the dashboard's Worker serves it under `/docs` with the rewrites in `apps/web/next.config.ts`. The pages describe
what the code does: change them in the same pull request as a change they describe.

Search engines should know the docs by their www.brigade.lol address, not Mintlify's: `docs.json`'s
`seo.metatags.canonical` is `https://www.brigade.lol/docs` (Mintlify appends each page's path without the `/docs` prefix, so the base must carry it), and the site's own `sitemap.xml` and `llms.txt` list the docs' pages
from `docs.json`'s navigation (`apps/web/lib/docs-pages.ts`).
The docs' own indexes for AI agents, `/docs/llms.txt` and `/docs/llms-full.txt`, are not proxied as they
are: Mintlify writes every link in them on its subdomain (`brigade.mintlify.dev`), which teammates then
followed and quoted to people. The site serves both itself (`apps/web/app/docs/llms*.txt`,
`apps/web/lib/docs-index.ts`), fetched from Mintlify with those links on www.brigade.lol.

## Search engines and AI assistants

What the site gives crawlers: `robots.txt` and `sitemap.xml` (`apps/web/app`), `llms.txt` (`apps/web/app/llms.txt`,
a Markdown summary for AI assistants, with links to the docs and comparisons), JSON-LD on the landing (the product,
the organization and the FAQ) and on each comparison (`apps/web/app/compare`, data in `apps/web/lib/compare.ts`, with
a source and a date for every line about another product). After a deploy that changes public pages, run
`node apps/web/scripts/indexnow.mjs` to have Bing and the other IndexNow engines crawl them again.

```bash
pnpm docs                                    # http://localhost:3333, reloads as you edit
pnpm --filter @brigade/docs check            # Mintlify's validation and broken links
```

## Theme

The web app uses [shadcn/ui](https://ui.shadcn.com) on Tailwind v4. Its palette, fonts, radius, spacing and shadows
come from one [tweakcn](https://tweakcn.com) theme (Violet Bloom by default). To switch, pass a theme name or any
tweakcn URL:

```bash
pnpm --filter @brigade/web theme violet-bloom
```

```bash
pnpm --filter @brigade/web theme "https://tweakcn.com/editor/theme?theme=amethyst-haze"
```

This rewrites `apps/web/app/theme.css` and `apps/web/app/theme-fonts.ts` only. `app/globals.css` maps the theme into
Tailwind and adds Brigade's status colors (`success`, `warning`, `destructive-text`); components in
`apps/web/components/ui` use theme tokens only, so nothing else changes. Light, dark or system is the user's choice
from the sidebar.

## Spike (build step 1)

`pnpm --filter @brigade/runner spike [workdir]` runs Claude Code through `HarnessAgent` with the bridge on this
machine, pauses a turn mid-stream, continues it, detaches and resumes.
