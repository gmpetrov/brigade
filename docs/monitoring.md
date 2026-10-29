# Monitoring and alerts

Brigade tells its operators when something of its own breaks: the API failing, runners or
cloud computers down, Stripe's or Resend's webhooks failing, background jobs throwing. All of
it is in `apps/api/src/ops/`. It is not for members: their own trouble (a teammate's account
signed out, a full disk) reaches them as tickets.

## Where alerts go

Set on the `brigade-api` Worker as secrets (`wrangler secret put`), each optional:

- `OPS_ALERT_EMAILS`: addresses, comma-separated. Mailed through Resend (`RESEND_API_KEY`)
  from `alerts@MAIL_DOMAIN`. Each mail counts toward the Resend account's monthly quota,
  shared with other products: alerts are few by design (below).
- `OPS_ALERT_WEBHOOK_URL`: a URL each alert is posted to as JSON. It works with:
  - Slack's and Discord's incoming webhooks, which show its `text` (`content` for Discord);
  - a Brigade custom app's trigger URL (Apps › Custom app), so that each alert starts a
    thread where a teammate looks into it. The post's `id` is one per notice, so a
    redelivery starts no second thread.
- `OPS_ALERT_WEBHOOK_SECRET`: signs those posts (`x-brigade-signature: sha256=<hex HMAC>`
  of the body), as a custom app with HMAC verification checks them.
- `OPS_TOKEN`: turns on `GET /health/ops` (below).
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`: turn on the Workers check (below).
  The token needs only Account Analytics: Read.

Without any destination, alerts are only logged (`ops alert (no destination set)`).

The post's body:

```json
{
  "id": "brigade-ops:api:1793023200000:firing:1793023260000",
  "source": "brigade-ops",
  "kind": "firing",
  "key": "api",
  "severity": "warning",
  "title": "API requests failing (500)",
  "detail": "12 in the last 5 min.\n\n9× GET /api/threads/:id: …",
  "firstAt": "2026-10-26T12:00:00.000Z",
  "at": "2026-10-26T12:01:00.000Z",
  "text": "🔴 API requests failing (500)\n\n…"
}
```

## When operators are told

One `OpsAlert` row per problem, by key. The checks run each minute and raise what they see;
operators hear:

- when a problem starts (`firing`), and at once when a warning turns critical;
- every 6 hours while it lasts (`reminder`);
- when it ends (`resolved`), if they were told it started.

A problem back within 30 minutes of its end is the same one: a `reminder`, not a new one.
A notice no destination took is sent again on the next run: a problem whose end could not be
told stays open until it is, and a turn for the worse that was not sent is tried again.

## What is checked

| Key                           | Problem                                                                                                                                        | Warning / critical                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `api`                         | Requests answered 500 (`app.onError`)                                                                                                          | 10 / 50 in 5 min                       |
| `stripe-webhook`              | Billing events not reconciled (answered 503, Stripe sends them again)                                                                          | 1 / 5 in 30 min                        |
| `stripe-signature`            | Billing webhook requests whose signature fails: `STRIPE_WEBHOOK_SECRET` is wrong?                                                              | 3 / 10 in 1 h                          |
| `stripe-endpoint`             | Brigade's billing endpoint missing at Stripe, or disabled by Stripe                                                                            | critical (checked every 30 min)        |
| `resend-webhook`              | Resend's events failing or badly signed (Brigade's email)                                                                                      | 3 / 20 in 30 min                       |
| `trigger-webhook`             | Triggers' webhooks (Stripe, custom apps) that could not start a thread                                                                         | 5 / 30 in 30 min                       |
| `turn`                        | Teammates' turns failing, in at least 2 workspaces                                                                                             | 6 / 25 in 15 min                       |
| `hub-op`                      | A workspace's hub operation asked from another object (`outcomeHere`) that threw: logged with its stack as `hub <workspace>: <op> failed`      | 3 / 15 in 1 h                          |
| `catalog-size`                | An App's catalog (its tools for a grant, `src/catalogs.ts`) over 2 M characters; over 8 M, its last tools are left out                         | 1 / 20 in 6 h                          |
| `runner-silent`               | Cloud computers' runners that stop their heartbeats without closing their connection                                                           | 3 / 10 in 15 min                       |
| `account-signed-out`          | An account marked `needs_sign_in` after 2 turns in a row failed for want of a login ("Not logged in · Please run /login")                      | 1 / 5 in 1 h                           |
| `runner-restart`              | Cloud computers' runners not back 2 minutes after an update's restart                                                                          | 1 / 5 in 1 h                           |
| `runner-reconnects`           | A computer's runner connecting 10 times within a minute: a reconnect storm                                                                     | 1 / 5 in 15 min                        |
| `runner-outbox`               | Commands refused: too many wait for a computer that stays down (`src/runner-commands.ts`)                                                      | 1 / 20 in 30 min                       |
| `jobs:dead`                   | Job messages that failed every try, waiting in `brigade-jobs-dlq` (once jobs are on the queue)                                                 | 1 / 20 waiting                         |
| `jobs:late`                   | The jobs' queue holding a message for 10 minutes: its consumer fails or is slow                                                                | warning                                |
| `job:<name>`                  | A background job throwing (schedules, wake-ups, mail, merges, cloud plans…)                                                                    | 3 / 10 in 15 min                       |
| `job:<name>-sweep`            | An hourly sweep throwing                                                                                                                       | 2 / 3 in 3 h                           |
| `computer:<id>`               | A cloud computer in `error`, stuck `creating`/`starting` for 20 min without its runner, or `running` with no runner for 10 min                 | critical, critical, warning            |
| `events-waiting:<computerId>` | Threads whose runner has sent the same events, unacknowledged, for 10 min (`events.waiting`)                                                   | warning; critical at 30 min            |
| `backlog:<computerId>`        | Commands (`RunnerCommand`) its runner has not acknowledged: 20 or more, or the oldest 30 min old; never a member's machine while it is offline | warning; critical at 100 or 3 h        |
| `disk:<computerId>`           | A `disk_full` ticket open on a cloud computer                                                                                                  | warning                                |
| `worker:<script>`             | A `brigade-*` Worker's or Durable Object's failed invocations (exceptions, exceeded limits), as Cloudflare counts them                         | 5 / 50 in 10 min (checked every 5 min) |
| `worker:<script>:resets`      | A `brigade-*` Worker's Durable Objects reset by the runtime: past their memory or CPU, or an internal error (each drops the object's sockets)  | 1 / 5 in 10 min (checked every 5 min)  |
| `api-down`                    | The watchdog: the Api object does not answer, or its checks fail                                                                               | critical                               |

A failure-count problem ends once none came for a while (15 minutes to 3 hours, by kind).
Computers of a workspace without a plan are meant to be off and are not checked.

The counts are in the Api object's memory (`src/ops/failures.ts`). A restart forgets them:
it only delays an alert, and resolves nothing until the quiet time has passed since. What
fails in a workspace's hub object, the cron or the jobs' consumer is counted there too, sent
by RPC.

Each minute, the API logs what the hubs it holds hold (`hubs: hubs 3, runners 2, browsers 5,
queued 0, …`), so a growth shows before it costs a restart. A workspace's hub object logs
`hub <id>: woke with N sockets` each time it wakes.

Turns failing in one workspace only are that workspace's trouble (its member's account, say),
not Brigade's: those are not alerted on.

## The watchdog

Every check above runs in the Api object, so none can say the object itself is down. The
Worker's cron (`scheduled` in `src/worker.ts`, each minute) pings the object, three times
20 seconds apart before it counts as down (a deploy resets the object), and its answer says
when the checks that need the database last succeeded: a database out of reach stops them,
and they could not alert on it themselves. When the object does not answer, or those checks
have not succeeded for 10 minutes, the cron sends `api-down` itself, at most once an hour, and `resolved` once it is
back. It reads the same secrets as the API.

Its resets (past its memory, as on 2026-10-27, or an internal error) are Cloudflare's to count:
`worker:brigade-api:resets`. It no longer counts its own starts: with the jobs on their queue
and the sockets in the hub objects, the runtime lets it go between requests, and each start
looked like a restart no deploy explains.

A whole Worker that does not deploy or load (its cron with it) is not seen from inside
Cloudflare: for that, an uptime monitor outside (Better Stack, UptimeRobot…) on
`https://api.brigade.lol/health/ops` with `Authorization: Bearer <OPS_TOKEN>` answers 200
when nothing critical is open, else 503, with the open alerts:

```json
{ "checksAt": "2026-10-26T12:01:00.000Z", "alerts": [{ "key": "computer:…", "severity": "critical", … }] }
```

Without `OPS_TOKEN` it answers 404.
