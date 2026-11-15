# Brigade.app

The desktop app, built with Electron for macOS, Windows and Linux. It lives in the menu bar (the
system tray on Windows and Linux) and:

- installs, links and keeps running the Brigade runner, so teammates work on this computer
  (macOS and Linux: the runner is POSIX only), for one of the workspaces linked here at a time
  (`src/runner.ts`, `src/workspaces.ts`);
- shows the dashboard in a window of its own (`src/windows.ts`), and a small new thread window,
  the dashboard's `/app/capture`, from a global shortcut (`src/capture.ts`);
- on macOS, takes screenshots for that window and lets teammates use the Mac's apps through
  Brigade Computer Use.app (`apps/computer-use-macos`), which it ships inside;
- walks a new member through what is missing (`src/setup.ts`, `page/setup.html`), opens at login
  (`src/autostart.ts`) and updates itself (`src/updates.ts`).

The dashboard window has no title bar on macOS (traffic lights over the sidebar's first row) and
Windows (the system's buttons over the top right); Linux keeps the desktop's own
(`src/windows.ts`). The dashboard lays itself out for it from the bridge's `frame`
(`apps/web/lib/desktop-frame.ts`): it keeps room for the buttons and marks the empty space that
moves the window (`data-window-drag`).

Its windows load the live dashboard (www.brigade.lol, or the dashboard the last link named): the
UI is the web app's, not a copy. Their pages reach the app through a bridge,
`window.brigadeDesktop` (`src/preload.ts`, `src/ipc.ts`), given only to the dashboard's own site
in Brigade's windows; `apps/web/lib/brigade-app.ts` uses it. Anything off the dashboard's site
opens in the browser, where providers' sign-ins work, and windows sign in through the browser too
(`/app/desktop-sign-in`, then `brigade://sign-in`).

## Develop

```bash
pnpm --filter @brigade/desktop dev:app   # bundle, fetch Electron, start it
pnpm --filter @brigade/desktop test      # unit tests
pnpm --filter @brigade/desktop build:app # package for this platform into release/out
pnpm --filter @brigade/desktop smoke     # start the packaged app against a stand-in dashboard
```

Point it at a local dashboard with `"dashboardUrl": "http://localhost:3000/app"` in
`~/.brigade/desktop.json`, or `BRIGADE_HOME` for a home of its own. Releases: `release/README.md`.
