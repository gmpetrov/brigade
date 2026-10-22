# The public demo

demo.brigade.lol is the real dashboard (`apps/web`) on recorded data, for a visitor of the
landing page to click around a believable workspace: the sample Acme workspace a preview
has (`apps/api/prisma/seed-workspace.ts`), signed in as Ada. No API runs behind it and no
request leaves the browser; a reload starts over.

## How it works

- **A build flag.** `NEXT_PUBLIC_DEMO=1` builds the demo (`lib/demo/flag.ts`). Without it,
  nothing changes: the demo's code is a few constants and an unreached `import()`.
- **The API answered in the browser.** `lib/config.ts` points the API at
  `https://api.demo.invalid`, an address that does not exist, and installs
  `lib/demo/install.ts` before anything asks it. That swaps `fetch` and `WebSocket` for
  that address only: `api()`, the direct `fetch()` calls (library, file preview, skills,
  design systems) and the live sockets (`use-live.ts`, `use-thread-events.ts`) all reach
  `lib/demo/server.ts`, loaded with its fixtures on the first request.
- **Recorded responses.** `lib/demo/fixtures.json` holds every GET the dashboard's pages
  asked for in a fresh sample workspace. Dates move with the time the demo opens, so the
  workspace always looks current. A GET with nothing recorded answers 404.
- **Writes in memory**, for what a visitor will try (`lib/demo/server.ts`):
  - approve or decline a ticket, answer a question or a teammate's ticket: the ticket
    closes everywhere and its thread goes on as the real one would (`afterDecision` in
    `lib/demo/scripts.ts`);
  - merge a pull request (`lib/demo/pulls.ts`, which stands in for GitHub, unreached in a
    preview);
  - archive, pin or put off a thread;
  - send a message or start a thread: the teammate answers with a scripted run, streamed
    with its tool steps as a runner streams one (`replyTo` in `lib/demo/scripts.ts`).
    Unknown requests get a reply that says what the demo knows, with three to click.

  Any other write succeeds and changes nothing. Attaching or uploading a file says it is
  off in the demo.

- **What needs a computer** (the app preview, a teammate's screen, a terminal) shows
  what it would be instead (`components/demo-machine.tsx`).
- **The sign.** A card at the foot of the sidebar (a strip atop the page on a phone) says
  it is a demo, with "Start free on your Mac" to www.brigade.lol/sign-up
  (`components/demo-banner.tsx`). Signing out goes there too; `/`, `/sign-in` and
  `/onboarding` open Home, and the pages are `noindex` (`next.config.ts`). In the landing
  page's frame, the sign hides (below).

The scripted replies only show what Brigade does: approvals follow each teammate's
permissions, a push opens the ticket in the app, account failover stays within one
provider, full computer use is on a Mac, and only built-in Apps are named.

## Recording the fixtures again

```bash
pnpm demo:record   # scripts/demo/record.sh
```

It seeds a fresh database of its own (embedded PostgreSQL on port 5499), runs the API, the
dashboard and the preview's sign-in proxy on ports 3300 to 3302, then
`apps/web/scripts/demo-record.mjs` opens every dashboard page in a headless Chromium as Ada,
follows each link, and writes what the API answered to `apps/web/lib/demo/fixtures.json`.
A running preview is left alone: its database, its ports and its `.next`. It takes about ten
minutes, most of it Next compiling each page the first time.

Record again after a change to the API's responses or to the seed, and commit the new file.
A page that asks for something new records it on its own. A new page needs a link to it from
one the recorder reaches, starting at `/app`.

## Trying it locally

```bash
cd apps/web && NEXT_PUBLIC_DEMO=1 pnpm dev   # http://localhost:3000/app
```

It needs no database or API. `pnpm test` in `apps/web` checks the demo's server.

## Deploying demo.brigade.lol

The demo is its own Worker, `brigade-web-demo` (`apps/web/wrangler.demo.jsonc`), built and
deployed like the dashboard's by `scripts/deploy/workers.sh`:

```bash
pnpm run cf:build:demo    # DEMO_RECORD=1 records the fixtures again first
pnpm run cf:deploy:demo
```

Its custom domain, `demo.brigade.lol`, is in that file: the first deploy added the DNS record
and the certificate on the `brigade.lol` zone. A Workers Build deploys it on each push to `main`
that touches what it is built from, as for the other Workers
([deployment-plan.md](deployment-plan.md)): build command `pnpm run cf:build:demo`, deploy
command `pnpm run cf:deploy:demo`, the same watch paths and build token as `brigade-web`, and
`PNPM_VERSION` as its build variable. It needs no secret, and it does not wait for the API.

## On the landing page

The landing page shows the demo in a window (`components/landing/live-demo.tsx`): a picture
of it (`public/landing/demo-light.webp` and `demo-dark.webp`) until the visitor presses "Try
the live demo", then the demo itself in a frame. The landing page loads none of the dashboard
until then. On a phone, the button opens the demo on its own. The demo allows only
www.brigade.lol (and localhost) to frame it (`frame-ancestors`, `next.config.ts`); in the
frame, its own sign hides, the page around it being the sign, and "Start free on your Mac"
opens in the whole window. Take the pictures again after a visible change to Home.
