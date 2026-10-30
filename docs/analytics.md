# Product analytics

Brigade measures where its members come from and which features they use, in PostHog's EU
cloud. The tracking plan (the library's `Projects/Brigade/decisions/analytics-tracking-plan.md`)
records why; this page says what the code sends.

Three rules hold everywhere:

- **No content.** No message text, title, name, file path, repository, email address or URL.
  Only ids, counts and values of a closed list (`kind`, `harness`, `provider`…).
- **No cookies.** The website runs PostHog in `cookieless_mode: 'always'`, with nothing kept in
  the browser. No session replay, no autocapture, anywhere.
- **The important steps come from the API**, not the browser: many developers block trackers,
  so sign-ups, activation and payments are sent by the API.

## Settings

| Variable                         | Where                                        | What                                                                                                        |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POSTHOG_KEY`                    | `brigade-api` secret (`wrangler secret put`) | The project's API key (`phc_…`). Without it the API sends nothing.                                          |
| `POSTHOG_HOST`                   | `brigade-api`, optional                      | Ingestion address. Default `https://eu.i.posthog.com`.                                                      |
| `POSTHOG_INTERNAL_EMAIL_DOMAINS` | `brigade-api` secret, optional               | Domains, comma-separated, whose people are Brigade's own: their events carry `internal: true`.              |
| `NEXT_PUBLIC_POSTHOG_KEY`        | `brigade-web` build variable (Workers Build) | The same key, inlined into the website at build time. Without it the site loads nothing. Never in the demo. |

Locally, in tests, previews and self-hosted Brigades none is set, so nothing is sent. PostHog's
project must have cookieless mode turned on in its settings, or it drops the website's events.

## The website

`components/landing/site-analytics.tsx`, mounted in the site's header (`/`, `/how-it-works`,
the legal pages). Never in the dashboard (`/app`), the sign-in pages or the demo's build: only
those pages import it, `posthog-js` loads with a dynamic import once the page runs, and
`next.config.ts` empties the key in the demo's build.

- `$pageview`, on each page, including the site's client-side navigations.
- `cta_clicked` with `location` (`header`, `hero`, `pricing`, `final`, `footer`…, from the
  section's `aria-labelledby`) and `target` (`sign_up`, `sign_in`, `github`, `demo`, `install`).

## Attribution

Without cookies, PostHog cannot tie a visit to a later sign-up. The origin travels in the
address instead (`lib/signup-source.ts`):

1. The first page of a visit reads its `utm_source`, `utm_medium`, `utm_campaign`, the
   referrer's host when it is another site's (`ref`), its own path (`lp`), and whether an ad's
   click id was there (`paid`).
2. The site's Sign up and Sign in links carry them (`components/landing/auth-link.tsx`):
   `/sign-up?utm_source=hn&ref=news.ycombinator.com&lp=%2Fhow-it-works`.
3. The sign-up and sign-in pages send them to the API: with the code
   (`signupSource` in `POST /api/auth/sign-in/email-otp`), or through Google's round trip
   (`additionalData.signupSource`, kept in the OAuth state).
4. When better-auth makes the user, the API (`recordSignup`, `src/analytics.ts`) checks them
   (`src/signup-source.ts`), keeps them on `User.attribution` once, never changed after, and
   sends `signed_up`.

The channel is `utm_source`'s when there is one, else the referrer's:

| Referrer                                                         | Channel              |
| ---------------------------------------------------------------- | -------------------- |
| `x.com`, `t.co`, `twitter.com`                                   | `twitter`            |
| `google.*` (no ad click)                                         | `google_organic`     |
| `news.ycombinator.com`                                           | `hacker_news`        |
| `producthunt.com`                                                | `product_hunt`       |
| `github.com`                                                     | `github`             |
| `reddit.com`, `linkedin.com`                                     | `reddit`, `linkedin` |
| `chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com` | `ai_search`          |
| `bing.com`, `duckduckgo.com`                                     | `other_search`       |
| any other                                                        | `other`              |
| none                                                             | `direct`             |

Links posted for a launch carry their own UTM (`?utm_source=hn&utm_medium=social&utm_campaign=launch`):
HN and X often drop the referrer.

The person's properties, set once by `signed_up`: `signup_channel`, `signup_source`,
`signup_medium`, `signup_campaign`, `signup_referrer`, `signup_landing_page`, `signup_method`
(`email_code`, `google`, `password`). Each event of a person also sets `internal`.

## The API's events

`src/analytics.ts` queues events and sends them together to PostHog's `/batch/` a moment later,
never waited on, never failing a request. On Cloudflare, the Durable Objects stay up to send them;
a run in the Worker's own isolate (the cron, the jobs' queue, stateless reads) waits for them
before it ends (`flushAnalytics`, `src/worker.ts`).

- **`distinct_id`** is the user's id. A teammate's or the system's action is the member's whose
  thread it is in; with no thread, it is `workspace:<id>`, with no person profile.
- **Group `workspace`**: every event of a workspace carries it. Its properties (`member_count`,
  `plan`, `created_at`, never its name) are sent when the workspace is made or changed, its
  organization's members change, or its plan changes.
- **`first`**: the funnel's events (`FIRST_EVENTS` in `src/analytics-events.ts`) say whether it
  is the person's first, from one row per person and event in `AnalyticsFirst`. People who were
  here before analytics have every row already (the migration), so none of theirs counts.
- **Activation** is a first `turn_completed` within 7 days of `signed_up`.

### From the audit log

Most events come from `audit()` (`src/audit.ts`): `AUDIT_EVENTS` in `src/analytics-events.ts`
maps an audit action to its event, its `feature` and the properties it picks from the entry's
data. A property goes only if its key is in `SAFE_KEYS` and its value is a number, a boolean or
a short word (`ENUM_VALUE`); the rest is dropped, whatever a rule returns.

| Feature            | Events (audit action)                                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding`       | `workspace_created`, `computer_chosen` (`runner.link_code_issued`, `kind` from the browser: `mac`, `linux`…; Checkout from onboarding and `POST /computers/cloud`: `cloud`), `ai_account_connected` (`provider`), `runner_connected` (`computer.linked`: `kind` `own_machine` or `cloud`, `os`) |
| `billing`          | `checkout_started` (`from`)                                                                                                                                                                                                                                                                     |
| `threads`          | `thread_started` (`origin`: `member`, `schedule`, `trigger`, `child`, `task`, `email`; `harness`), `message_sent` (`thread.prompted`, and a member's new thread), `thread_interrupted`, `thread_retried`, `thread_handed_off`, `files_attached`                                                 |
| `teammates`        | `teammate_created` (`harness`), `teammate_updated`, `teammate_archived`                                                                                                                                                                                                                         |
| `projects`         | `project_created`, `project_repositories_set` (`repo_count`)                                                                                                                                                                                                                                    |
| `library`          | `library_file_created`, `library_file_edited` (a file replaced), `library_folder_created`                                                                                                                                                                                                       |
| `designs`          | `design_edited`, `design_picked`                                                                                                                                                                                                                                                                |
| `previews`         | `preview_started`, `preview_opened`                                                                                                                                                                                                                                                             |
| `pull_requests`    | `review_requested` (`by`), `pull_request_merged` (`by`: `button` or `teammate`)                                                                                                                                                                                                                 |
| `apps`             | `app_connected`, `app_removed` (`app`)                                                                                                                                                                                                                                                          |
| `vault`            | `credential_created` (`kind`), `credential_used`                                                                                                                                                                                                                                                |
| `routines`         | `schedule_created`, `schedule_run` (run now), `trigger_created`, `trigger_received` (`app`)                                                                                                                                                                                                     |
| `playbooks`        | `playbook_installed`, `playbook_dry_run`, `playbook_activated`, `playbook_uninstalled` (`playbook`: its slug)                                                                                                                                                                                   |
| `email`            | `email_address_enabled`, `email_domain_added`, `email_sent`                                                                                                                                                                                                                                     |
| `tickets`          | `ticket_answered` (`kind`, `outcome`, `response_s`)                                                                                                                                                                                                                                             |
| `memory`, `skills` | `memory_written` (`kind`), `skill_proposed`, `skill_approved`                                                                                                                                                                                                                                   |
| `computer`         | `takeover_started`                                                                                                                                                                                                                                                                              |
| `team`             | `member_invited`, `member_joined` (`role`)                                                                                                                                                                                                                                                      |

### Sent from elsewhere

| Event                                                                                                                                   | Where                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `signed_up` (`method`, `channel`)                                                                                                       | `recordSignup`, from better-auth's `databaseHooks.user.create.after` (`src/auth.ts`)   |
| `turn_completed` (`harness`, `duration_s`, `outcome`: `done`, `interrupted`, `error`)                                                   | `trackTurns`, once a run of a thread's events is stored (`src/hub/runner-messages.ts`) |
| `ticket_opened` (`kind`: the ticket's type)                                                                                             | Every ticket made through a scoped client (`onScopedWrite` in `src/analytics.ts`)      |
| `pull_request_opened` (`by`)                                                                                                            | `notePullRequestCall` in `src/pull-requests.ts`, when a teammate opens one             |
| `subscription_started` (`plan`, `currency`, `amount`), `subscription_canceled` (`months_active`, `reason`), `payment_failed` (`status`) | `savePlan` in `src/billing.ts`, when Stripe's status changes                           |

## Errors

PostHog's error tracking gets the errors Brigade meets, as `$exception` events
(`src/error-tracking.ts`), through the same queue, so nothing is sent without `POSTHOG_KEY`.
They feed the backlog's daily triage (the library's `Projects/Brigade/backlog.md`).

- **The API's**: a request that failed with a 500 (`app.onError`, `kind` `api:<method> <route>`),
  a hub's operation that threw (`hub-op:<name>`, sent from the object it ran in, not again where
  it was asked), and every failure the ops checks count that carries an error (`noteFailure`
  with an `Error`: `job:<name>`, `resend-webhook`, `held-calls`…). With its stack and causes,
  `source: 'api'`, the build (`BRIGADE_BUILD_ID`) and the workspace's group when there is one.
- **The dashboard's**: errors nothing caught and promises nobody handled in `/app` and
  `/onboarding` (`components/error-reports.tsx`), and what `/app`'s error boundary caught
  (`app/app/error.tsx`). `lib/error-reports.ts` sends them to `POST /api/errors`
  (`src/routes/errors.ts`, signed in), never to PostHog from the browser: nothing of a third party
  loads in the dashboard, and blockers do not drop them. Left out there: the API's own refusals
  and failures (`ApiError`, reported by the API), the network gone, cancelled requests, a script
  of an older build gone after a deploy (`ChunkLoadError`) and cross-origin `Script error.`; the
  same message once per page load, 20 at most. The API drops a report whose stack holds none of
  the dashboard's scripts (a browser extension's), and takes 30 a minute per person at most.
  `source: 'dashboard'`, `how` (`uncaught`, `unhandled_rejection`, `boundary`), `build`, `path`.

**No content, as far as an error allows.** A message loses its email addresses and keeps only the
site of each link (`https://api.github.com/…`), a page only its first two segments
(`/app/pulls`, never a repository's name), a stack frame its file's query. The same error goes at
most 5 times a minute from one process, so a loop that fails cannot spend PostHog's quota. The
dashboard's frames are its minified scripts: no source maps are uploaded yet.

## Adding an event

1. For an action already audited: add its line to `AUDIT_EVENTS` (`src/analytics-events.ts`),
   named `object_verb`, with its `feature`. Data the audit entry lacks goes in `audit()`'s
   `track` (enums and counts), which is not kept in the log.
2. For anything else: `trackLater(person, event, scope, properties)` from `src/analytics.ts`,
   with `personOfMember` or `personOfThread`.
3. A new property key goes in `SAFE_KEYS`. Never add one that could hold content.
4. A new funnel step that should say `first` goes in `FIRST_EVENTS`, with a migration that adds
   its row for the people already there.
5. `test/analytics.test.ts` checks every rule against data full of content.

## Not sent yet

- `demo_interacted`: the demo runs in another site's frame, whose clicks the page cannot see.
- `app_tool_called`, `computer_use_session`, `email_received`, `desktop_app_installed`,
  `pwa_installed`, `push_enabled`, and `runner_connected`'s `via` (the runner's link does not
  say whether Brigade.app or install.sh made it).
- `payment_failed`'s `attempt`: the subscription does not carry it.
