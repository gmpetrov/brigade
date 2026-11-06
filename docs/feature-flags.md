# Feature flags

Some features stay hidden until they are ready, open only to the people trying them. Brigade
keeps this in its own database: no outside service, nothing sent anywhere, and it works the same
locally, in previews and on a self-hosted Brigade.

## Declaring a feature

Each feature is declared in `packages/contracts/src/features.ts`, with whether people have it
when the database says nothing of it (`default`):

```ts
export const FEATURES = {
  gmail: { description: 'Connect Gmail accounts…', default: false },
  …
}
```

A feature with `default: false` is hidden from everyone until a row opens it.

## Opening it to people

One `FeatureFlag` row per feature (`apps/api/prisma/schema.prisma`) says who has it. A person
has it when any of these holds:

| Column         | Opens it to                                                       |
| -------------- | ----------------------------------------------------------------- |
| `everyone`     | Every person.                                                     |
| `emails`       | These sign-in addresses, or whole domains written `@example.com`. |
| `workspaceIds` | Every member, while they are in one of these workspaces.          |

`note` says why, for whoever reads the table. Without a row, the declared default applies.
Rows are read on every request, never cached: a change applies at once.

```sql
-- Open Gmail to two people and to the whole team's domain.
INSERT INTO "FeatureFlag" ("key", "emails", "note")
VALUES ('gmail', ARRAY['ada@example.com', 'bob@example.com', '@chaindesk.ai'], 'Google test users until CASA')
ON CONFLICT ("key") DO UPDATE SET "emails" = EXCLUDED."emails", "note" = EXCLUDED."note", "updatedAt" = now();

-- Add one more address.
UPDATE "FeatureFlag" SET "emails" = array_append("emails", 'carol@example.com'), "updatedAt" = now()
WHERE "key" = 'gmail' AND NOT 'carol@example.com' = ANY("emails");

-- Ready for everyone: open it, then remove the flag from the code in a later change.
UPDATE "FeatureFlag" SET "everyone" = true, "updatedAt" = now() WHERE "key" = 'gmail';
```

Addresses are compared without case. Locally, `prisma/seed.ts` opens every hidden feature to
everyone, as before it was hidden; set a row's `everyone` to false to see the feature as people
without it do.

## Using it

In the API (`apps/api/src/features.ts`):

- `featuresOf({ email, workspaceId })`, `featuresOfUser(userId, workspaceId)` and
  `featuresOfMember(memberId, workspaceId)` give the features a person has.
- `requireFeature(features, 'x')` answers 404 to someone without it, for a route that should not
  seem to exist.

In the dashboard, `GET /api/me` gives the person's features (`Me.features`): hide a page, a menu
entry or a button with `me.features?.includes('x')`. The dashboard only hides; the API must refuse
too.

## Apps behind a feature

`APP_FEATURES` ties an App to a feature. For someone without it:

- `GET /api/connections` lists the App in `hidden` and marks it not `available`: the catalog
  does not offer it (unless the workspace already has it, whose accounts stay in reach), and its
  Add and Connect buttons are off, saying it is not available to their account yet;
- `POST /api/connections/google` refuses to start its sign-in (403);
- a teammate's `list_apps` does not offer it to connect, when the person its thread works for
  lacks it.

Accounts already connected keep working, for everyone the workspace gives them to.

## Features now

| Feature            | Why it is hidden                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail`            | Gmail's restricted scope (`gmail.modify`) needs Google's CASA audit. Until then Google blocks every account that is not a test user of the Google app: open it to those same addresses.                                                                                                              |
| `google_drive`     | Drive's full `drive` scope is restricted like Gmail's.                                                                                                                                                                                                                                               |
| `preview_machines` | A machine of its own for each thread (docs/previews.md): its preview runs there, and its teammates run heavy commands there (`run_on_machine`). Tried by the team first, before other workspaces. A member who has it sees "Keep heavy work off the shared computer" in Preferences, off by default. |
