# Previews

A teammate runs the app it works on (usually a dev server) with `start_preview`,
and people try it beside the thread, in a frame, or in a tab. The runner keeps
the process (`apps/runner/src/previews.ts`); the API hosts its port with the
provider and hands out the address with its token (`apps/api/src/app-previews.ts`).

## Decisions

- **Previews are on another site than the dashboard.** A customer's code runs in
  them: on the dashboard's site it could set the dashboard's cookies and send it
  requests with a person's session. The cost is that the frame is a third party
  to its own app.
- **A proxy in front of every preview** (`apps/runner/src/preview-proxy.ts`). The
  provider hosts the proxy's port (`publicPort`), not the app's. It fixes what
  apps cannot be asked to change:
  - **Cookies.** In a frame on another site a browser drops `SameSite=Lax` and
    `Strict` cookies, so signing in to the app does nothing. Over HTTPS the proxy
    rewrites every `Set-Cookie` to `Secure; SameSite=None; Partitioned` without
    `Domain`: kept for the dashboard's frame only (partitioned, so not a tracking
    cookie) and for the preview's host only. Tested in Chrome 151: an app's
    `Lax` session cookie is dropped in the frame, the rewritten one keeps it
    signed in across reloads. A preview is for trying the app, so loosening its
    own CSRF protection from `Lax` to `None` is accepted.
  - **One address.** The app's other ports (its API) are paths on the preview's
    address, `/__ports/<port>/` (stripped before the app sees the request,
    `X-Forwarded-Prefix` set, redirects to `/…` kept under the prefix). One
    origin means one provider token and no CORS. `BRIGADE_PREVIEW_URL_<port>`
    carries the path, so `NEXT_PUBLIC_API_URL=$BRIGADE_PREVIEW_URL_3001` works.
  - **No blank frame.** While the app starts, restarts or does not answer, a page
    navigation gets a page that says so and reloads every 2 seconds; other
    requests get a plain 502.
  - **Use keeps it alive.** Any request through the proxy counts as use, so a
    preview someone is using does not expire.
- **Crashes restart.** An app that stops after it answered starts again after
  1, 3 and 10 seconds; a fourth stop within 10 minutes fails the preview. An app
  that never answered fails at once, as before: its command is wrong, and the
  teammate should see that.
- **New tab as the way out.** The pane has an "Open in a new tab" button and,
  under the frame, a line saying to use it when signing in does not work.
  Opened in a tab the preview is a first-party site and everything works.

- **Checked before "ready".** A status code says nothing about a page that
  renders empty (a form hidden until a CAPTCHA passes) or a home page whose data
  query failed. Once the app answers, `start_preview` opens its `paths` (default
  `/`) with the computer's Chrome, at the address people open with its token
  (`preview.expose` with `token`), as the teammate (`preview-check.ts`). Per
  page: its status, blank (no text and nothing drawn), an empty body inside its
  header and menu (nothing below the top 12% or right of the left 10% while
  something is there; it looks again for 8 seconds, for a CAPTCHA or slow data),
  script errors, the page's own 5xx requests, a screenshot; plus the lines the
  app logged meanwhile that look like errors. Console errors (hydration
  warnings) are warnings, not failures. `check_preview` runs it again, only when
  the person asks, after a crash or restart, or once after fixing what the last
  check found: not after each edit while the person tries it, since they see it.
  A page meant to look empty is saved with `save_preview({ reason })` after the
  teammate looked at it.
- **A check always ends.** While the proxy serves its waiting page, the check
  asks for the page without opening it (opened, it reloads itself and
  interrupts the check's navigation), and opens it once the app answers. Calls
  into a page Playwright gives no timeout (`evaluate`, `title`, closing) get 2
  seconds: a page whose server never answered stays mid-navigation, and they
  waited for it until the runner killed the check after 3 to 5 minutes, with no
  result. An app that never answers fails after about 90 seconds and says so.
- **Set up in `start_preview`, saved per repository.** What a preview needs goes
  in the tool, not the teammate's shell, so it can be kept: `setup` (install,
  `docker compose up -d`, migrate, seed; its own `sh -e`, run on each start but
  not on a crash restart), `env` (`${BRIGADE_PREVIEW_URL}` and
  `${BRIGADE_PREVIEW_URL_<port>}` become addresses; optionally merged into the
  app's `envFile`), `credentials` (vault ids, loaded from their private env
  files), `paths`. `save_preview` keeps it as the repository's `PreviewRecipe`
  (one per workspace and repository, `cwd` relative to the checkout's root),
  only once its check passed. `start_preview({ repository })` starts it again
  in any later thread with that repository checked out. Secrets stay in the
  vault: a recipe holds credential ids, never values.
- **Preview variables, beside the recipe.** Values only a person has (a
  third-party API key) are a repository's `PreviewVariable`s: a setting (value
  kept as is), a secret (sealed in a `VaultSecret`, never read back by the
  dashboard) or a generated secret. They are not vault credentials and do not
  show on the Vault page. A teammate asks for them with a `variables` ask in
  `open_ticket`; the person saves them from the ticket (or on Saved previews)
  before answering, and the reply carries names only. Each start of the
  preview, by a teammate or by a person without a turn, reads them through the
  `variables` preview operation (audited when it holds secrets) and puts them
  in the app's environment over `env`, and in its `envFile` (then added to the
  checkout's `.git/info/exclude`). The teammate sees their names in
  start_preview's result; a secret's value is hidden in the preview's log. The
  app runs as the teammate's user, so a teammate that went looking (its
  process's environment, its env file) could read one: what this keeps them out
  of is the model's context by default, the dashboard and the logs. Any member
  sets or replaces one; whoever set it last, an owner or an admin removes it.
  Credentials in a recipe still need its teammate to start it.
- **Started when a person asks.** A teammate starts a preview when the person
  asks to try the app, or asked for something to try in a browser; otherwise it
  offers one in a line. Setting one up takes minutes and keeps the computer busy,
  so it is not done for every change. People start one with Preview at the top of
  a thread or on a pull request (`POST /threads/:id/preview/start`): the runner
  starts it without a turn (`preview.start`, protocol 17) again as it last
  started, or from the saved setup of a repository checked out in the thread,
  then checks its pages itself. With nothing saved, the dashboard explains what
  setting one up involves (the first time only, unless kept) and asks the teammate.
- **Ready means checked.** Previews report their step while starting (`setup`,
  then `app` once the wrapper prints `[preview] Starting the app`) and their
  check (`checking`, `passed`, `failed` with the pages). The thread says "ready"
  once the check passed, not when the port answered; a failed check says which
  pages and offers to ask the teammate to fix them. Runners before this send no
  `startedAt`, and their `running` still reads as running.
- **Its last start is remembered** per thread, in the runner's state
  (`previews.json`), so Start again works after it expired, failed or the runner
  restarted. Not its credentials: a preview that uses vault credentials is
  started again by its teammate, who releases them. While one runs, its
  credentials' env files are copied beside the turn's (removed when it ends), so
  a restart after a crash, or by a person, still has them after the turn parked.
- **$PORT for a free port.** A command that reads `$PORT` gets another port when
  its own is taken (two threads previewing the same repository); a fixed port
  fails with the thread whose preview has it.
- **Pull requests.** A pull request a teammate opened previews in its thread,
  beside the pull request page, which says when the preview runs another commit
  than the pull request's head. One opened outside Brigade gets a thread where a
  teammate checks out its branch and starts it. A merged or closed pull request
  stops its thread's preview. Saved setups are listed with their repository
  (its page under Pull requests, and the Repos tab of each project that links
  it), where an owner or admin forgets one.
- **A stable address per repository.** A repository's preview gets its proxy
  port from its name (30000 + a hash), so its address stays the same on that
  computer: an OAuth callback registered once keeps working. Across computers
  it changes until previews have their own domain.
- **Each teammate has its own Docker.** Projects run their database, cache and
  mail with `docker compose`; giving teammates the root daemon's socket would
  make them root. The root setup installs what rootless Docker needs (`uidmap`,
  `slirp4netns`, `dbus-user-session`, an AppArmor profile for `rootlesskit`
  where Ubuntu restricts user namespaces), and the helper's `containers`
  starts a daemon under the teammate's user session (`loginctl enable-linger`).
  The runner sets `DOCKER_HOST` and `XDG_RUNTIME_DIR` for that teammate's turns,
  terminals and previews. Where the computer has no Docker, nothing changes.

## Known limits

- **Safari** blocks third-party cookies, and may not keep partitioned ones: not
  tested. Sign-in there needs the new tab.
- **Google, GitHub and Microsoft sign-in** refuse to load in a frame on another
  site, whatever the cookies.
- **Cookies set by scripts** (`document.cookie`) do not pass the proxy. Rare for
  sessions; storage (`localStorage`, as Supabase and Firebase use) works in the
  frame, kept for it.
- **The provider's own token cookie** must also work in a cross-site frame
  (`SameSite=None`, ideally `Partitioned`). It does in Chrome today.
- **Rootless Docker** cannot bind ports under 1024 and keeps images in each
  teammate's home: a project that publishes port 80, or many large images, needs
  changing. Not tested on a workspace computer yet (see below).
- **Seeds that call third-party APIs** (a Stripe product list) fail without a
  key: the teammate asks for a test-mode key as a preview variable, or seeds
  what it can and says what is empty.

## Before customers use it

1. **A preview domain Brigade owns** (e.g. `brigade-preview.app`), one subdomain
   per preview, served by the provider or a gateway in front of it. Today
   previews are on `*.on.boat.dev`.
2. **That domain on the Public Suffix List** (github.com/publicsuffix/list), as
   `vercel.app`, `netlify.app`, `github.io` and `csb.app` are. Without it every
   preview is the same site as every other, and one customer's preview can set
   cookies another's receives. `boat.dev` is not on the list. Inclusion takes
   weeks: start early.
3. **Test in Safari and Firefox**: signing in to an app in the pane, and the
   provider's token cookie in the frame.
4. **Test rootless Docker on a workspace computer** after deploying: the root
   setup runs again by itself (its stamp changed); then a teammate runs
   `docker compose up -d` in a repository with Postgres and Redis.
