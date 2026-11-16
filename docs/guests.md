# Guests

Brigade.app starts without a sign-in. The first time its window opens, the person is a guest at
once, greeted by their computer's own name: they get a project of their own, link this computer,
and their teammates run on the Claude or ChatGPT login already on it. They save the account with
an email whenever they like.

Only in Brigade.app's main window (`lib/guest.ts` in the dashboard, `inDesktopApp()`), on a Mac or
Linux, where its runner runs teammates. The website's sign-up is unchanged.

## How it works

- **No button, the first time**: the sign-in page, in Brigade.app's window, starts the guest at
  once and shows **Getting your workspace ready…** with **Already have an account? Sign in**. A
  window someone was ever signed in to (the `brigade_known` cookie, kept through signing out,
  `lib/signed-in.ts`) shows the sign-in instead, with **Start without an account** as a button:
  signing out never makes a guest on its own.
- **Their name**: Brigade.app reads its account's full name on this computer (macOS's `id -F`,
  Linux's GECOS field; never the login's short name, an address or a generic name such as
  `admin`: apps/desktop/src/system-name.ts) and gives it to the page as the bridge's
  `info.userName`. The guest is made with it (`name` in `POST /api/auth/guest`), else `Guest`. An
  app before it gives none.
- **The feature flag `guest_mode`** opens it, to everyone or nobody: a guest has no address
  for `emails` or a workspace for `workspaceIds` yet (docs/feature-flags.md).
  `GET /api/auth/guest/available` says whether it is open, and the sign-in page shows the button
  only then.
- **Starting** (`POST /api/auth/guest`, the `guest-sign-in` better-auth plugin in
  `apps/api/src/guests.ts`): a user with `guest` set, that name (else `Guest`) and a placeholder address
  `guest-<uuid>@guest.brigade.invalid`, which never receives mail nor matches a flag's domain.
  The window is signed in with a session of 400 days: signed out, a guest could never sign in
  again, and better-auth's refresh would cut a session to a week. Five a visitor an hour
  (`limitOf` in `src/auth.ts`). Its sign-up is recorded as any other, with `method: guest`
  (`signed_up`, docs/analytics.md).
- **Their project** is made by the page as onboarding makes one, named `My project`, then
  onboarding goes on from its computer step. There, in Brigade.app, the computer is this one:
  **Link this Mac** asks for a link code and opens its `brigade://link`, which the app takes
  itself after asking (apps/desktop/src/links.ts). A guest's link starts on its own, once. A
  guest is not offered Brigade Cloud.
- **What waits for the account to be saved** answers 403 (`requireSavedAccount`): inviting
  someone (`POST /api/members/invitations`) and Brigade Cloud's Checkout
  (`POST /api/billing/checkout`). What costs Brigade comes with Brigade Cloud only, which a guest
  cannot buy: the cloud computer, Brigade's email addresses, dictation. Nothing a guest does
  runs on Brigade's money: teammates run on their computer and subscription.
- **Room**: once a guest's project has stored 50 MB of its threads' work (`WorkspaceEventDay`,
  as stored), starting a thread or writing in one answers 402 until they save the account
  (`requireGuestRoom`).

## Saving the account

The sidebar's foot shows **No account yet** with **Save my account**, and Sign out offers it
first (a guest signed out loses the project). The dialog (`components/save-account.tsx`):

1. `POST /api/auth/guest/save/code` with the email: a 6-digit code mailed as a sign-in code is.
   Refused for an address with an account already (409). One code at a time; a guest mails 5 at
   most, since a guest is made without a check that a person is there (429 after).
2. `POST /api/auth/guest/save` with the email and the code: 5 wrong tries use the code up. The
   user takes the address, verified, `guest` goes, and the name `Guest` with it. The session
   goes on. `guest_saved` is sent.

From then on, they sign in with that email anywhere, like anyone.

## Sweeping

Hourly (`guest-sweep` in `src/jobs.ts`, `sweepIdleGuests`), a guest made more than 14 days ago,
none of whose project's threads moved and whose runner (which Brigade.app keeps running)
answered in the last 14 days, is deleted with their project, as deleting an account deletes it
(`src/account-delete.ts`). 10 a run; one still at work is refused there and left for later.

## Not yet

- Windows: the button stays off until teammates run on Windows (`desktopPlatform()`).
- Saving with Google, and moving a guest's project into an account that exists already.
- Brigade.app's setup window still says to connect from the dashboard; the main window's guest
  path links the computer without it.
