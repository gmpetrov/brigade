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
