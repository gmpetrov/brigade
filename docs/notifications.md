# Notifications

Web push to the dashboard, installed as an app (Add to Home Screen on iPhone,
Install in Chrome or Edge) or open in a browser. No email or other channel for
now. The rule: **a push means something waits on you.** Everything else stays
in the dashboard.

## Decisions

- **Presets, not a grid of checkboxes.** In Settings, Preferences, Notifications:
  - _Only when I'm needed_ (default): the Needs you items that are theirs.
  - _Needed + finished work_: also each task done and pull request merged, as
    soon as it is (its own push; a merge whose task is done is said once).
  - _Everything_: also replies in threads they started (not a task's thread).
- **Whose it is.** A ticket notifies who it waits on (`waitsOn` in
  `apps/web/lib/api.ts`), but admins only for what only they decide (spending
  caps, a credential without an owner) or what has nobody else. A task in Needs
  you without a ticket (waiting, failed, or a pull request to review) notifies
  its thread's starter.
- **A failed thread waits on whoever started it**, everywhere at once: Home's
  Waiting on you and the count beside Home, the sidebar (where its dot stays
  red), the app badge, pushes ("Riley's thread failed"), Tasks' Needs you, a
  list line's state and the Board. One rule, `apps/api/src/failed.ts`: a
  thread of the last 14 days, not a child (its parent's teammate hears of it),
  archived, put away for later, a playbook's run nobody joined or a routine's
  run. After an error its runner tries again on its own (the network, an
  overloaded API, memory; `PASSING_ERROR` in `@brigade/contracts`), it waits
  only once those tries are over, 16 minutes after that error, so a turn that
  comes back by itself never notifies. It counts once, by its thread: its pull
  requests wait with it, not on their own. Home no longer offers to dismiss it:
  Do later or Archive puts it away.
- **A routine waits on its owner** when its last firing could not start (unless
  the question ticket it opened is still open: that ticket is the item), or its
  latest run failed (with the same wait after a passing error), until it runs
  again or is paused. One item per routine ("Routine Morning digest failed").
- **Sparse.**
  - A Needs you item is sent once it has lasted a minute, so a burst settles
    into one push, and things resolved within the minute never notify.
  - One push per sweep (every 30 s): several things due are one notification.
  - At most 4 pushes an hour per member; past that, what is due waits and goes
    out together.
  - One reminder, 4 hours after the push, if it still waits. Never a second.
  - Nothing while the member has a dashboard in view and focused, or had one
    in the last 2 minutes: what is due counts as seen.
- **One notification per thread** (its tag): a new one replaces the old.
  Notifications whose thing no longer waits close with the next push, and all
  of them once the member opens the dashboard.
- **The app icon badge counts what needs the member**, as the sidebar does. It
  updates with each push and whenever the dashboard is open.
- **No silent pushes.** Browsers (Safari above all) drop subscriptions that
  receive pushes without a notification, so closing and the badge ride along
  with real notifications.
- **No other notification UI**: no inbox, banner or toast.

## How it works

- `apps/api/src/notifications.ts`: the sweep. It works out what should notify
  each member who has a device, compares that with `PushNotice` (what was sent,
  reminded, resolved, closed) and sends what is due.
- `apps/api/src/web-push.ts`: Web Push on WebCrypto alone (RFC 8291 payload
  encryption, RFC 8292 VAPID), so it runs on Node and on Workers.
- `apps/api/src/routes/notifications.ts`: the preset and this browser's
  subscription (`PushDevice`, one user's at a time), and a test push.
- `apps/web/public/sw.js`: shows a push, closes, sets the badge, opens the
  thread on click. `apps/web/app/manifest.ts` and the icons make the dashboard
  installable.
- Presence: each dashboard socket says when it is in view (`presence`), so the
  API knows who is looking (`isLooking` in `hub.ts`).

## Setup

The API needs a VAPID key pair (`pnpm --filter @brigade/api vapid`) as
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, and optionally `VAPID_SUBJECT`
(mailto: or https:; default: the dashboard's address). Without them, the panel
says notifications are not set up. Keep the pair once set: a new one
unsubscribes every device. `scripts/preview/setup.sh` adds one locally.

On iPhone (iOS 16.4 or later): open the dashboard in Safari, Share, Add to
Home Screen, open Brigade from there, then Settings, Preferences, Notifications,
Turn on. Push needs HTTPS: localhost works on a computer, not from a phone.
