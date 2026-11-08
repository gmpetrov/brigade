# What VMs cost

Brigade counts, for each workspace, what its VMs cost at the provider (boat.dev): its cloud
computer, and its threads' own machines (the `preview_machines` feature, [previews.md](previews.md)).
For each it keeps every run: the start (a create or a resume, which boat counts as one start
each) and how long the VM ran until it stopped. Code: `apps/api/src/vm-costs.ts`; prices:
`packages/providers/src/boat/prices.ts`.

## What is recorded

One `VmRun` row per run of a VM: whose it is (the workspace; the cloud computer, or the thread's
machine and its thread), the provider's id of the VM, its size, how it started (`create`,
`resume`, or `found`), when it started and stopped, and who stopped it (`brigade`, `provider`
for boat's own stops, `destroyed`).

- **Before** Brigade asks boat to make or start a VM, the run is written `pending` (`beginRun`).
  A VM has at most one run that runs or may run (a unique index on `sandboxId` over `pending`
  and `open`), so a start asked again (a retry, a restart after a crash) is the same run.
- A create gives the run its VM as soon as boat has it (`onCreated`, before the wait for it to
  be up), since it bills from then. A making retried under the same key (a preview machine's
  `Idempotency-Key`) gets the same VM: the retry's run is void and the first one counts.
- Once boat answered, the run is `open` (`runStarted`), from the moment boat was asked to resume
  (`StartResult.resumedAt`). A VM boat said was up already, with no earlier start of that run cut
  short, is `found`: counted from then, and as no start.
- Brigade's stops and destroys close the run (`runStopped`): the cloud computer's idle stop and
  its stop without a plan, a replaced VM's stop, a VM destroyed; a thread machine's sleep, its
  sweep's stop and destroy.
- **boat's own stops** (its auto-stop after `ttlSeconds`, a stop from its dashboard) come in by
  its webhook, `POST /api/boat/webhook`: `sandbox.archived` closes the open run at the event's
  time, never one started after it, so a late or repeated event changes nothing more. Requests
  are verified with `BOAT_WEBHOOK_SECRET` (HMAC-SHA256 of `delivery.timestamp.body`, at most 5
  minutes old); without the secret the route answers 404 and the minute's check does the work.
- **Each minute** (`vm-runs` in `src/jobs.ts`), `reconcileVmRuns` reads boat's list of the
  account's VMs once, then:
  - a pending run older than 15 minutes (its start's process died): open if its VM runs; if not,
    closed when boat's usage says it stopped, or void when boat says it never ran;
  - an open run whose VM is stopped, in error or gone (a stop whose record was lost, or boat's
    own stop without the webhook): closed at its start plus the time boat says it ran, no earlier
    than when it was last listed running (`seenAt`) and no later than the list;
  - a create that never got its VM after 15 minutes: void (nothing says one was made);
  - a VM of Brigade's (a cloud computer, a VM a replacement left, a thread's machine) running
    without a run: one from before runs were kept, or started outside Brigade. It gets a `found`
    run from the list's time, unless its run changed after the list was read (a stop recorded
    meanwhile).
    Every write is conditional on the row as it was read, and nothing begun after the list was
    read is judged from it.
    When boat's list fails in a way only waiting mends (a 5xx, a 429, no answer before its
    deadline), that minute's check is skipped with a warning and the next one settles everything;
    any other failure of the list (a 4xx: a key refused) fails the job, reported with boat's status.
- Recording never holds a VM back: a failed write is logged (`vm-runs:record`) and the minute's
  check settles the run.

## Reading it

Per workspace and calendar month (UTC):

- **Cloud computer**: starts, hours running and their cost at its size's hourly price, for each
  VM it had (a replacement makes a new one).
- **Threads' machines**: how many VMs ran, their starts, hours and cost, in total and per thread
  (a deleted thread keeps its runs, without its title).
- **Snapshots**: none billed. The snapshot boat takes at each stop is free; Brigade saves no named
  snapshot (10 are included per $20 of plan, then $0.056 a day each).
- **Total**: the two summed.

A run across a month's end is split at it; a run still open counts until now; void runs count
nothing; `found` runs count their hours, not a start.

The figures are estimates at boat's list prices (`VM_PRICES`: `2x4` small $0.018/h, `4x8`
default $0.036/h, `8x16` large $0.072/h, per second while running). Included plan time, trial or
wallet credits are not taken off. Starts are included for the whole account (12 a minute, 60 an
hour, 200 a day on the $20 plan), then $0.03 to $0.07 each with extra starts on: the operator view
lists the days over 200.

To check them, boat gives each VM's own figure over a window (`GET /sandboxes/{id}/usage`): the
workspace's view puts it beside each VM (`boatCost`) and in total (`boatTotal`).

## Where to see it

For Brigade's team, behind `OPS_TOKEN` as a bearer token:

- `GET /ops/vm-costs?month=2026-11` (this month by default): every workspace's cost, the costliest
  first, the account's starts per day over the included ones, the prices used, and boat's
  `/limits` for the account (starts and included time left, wallet).
- `GET /ops/vm-costs/:workspaceId?month=2026-11`: one workspace's, each VM and thread, with boat's
  own figure beside each.

## Setting up boat's webhook

Optional: without it, boat's own stops are seen within a minute. To have them at once, create a
webhook at boat for `sandbox.archived` to `https://<API>/api/boat/webhook`, and set its signing
secret as the `BOAT_WEBHOOK_SECRET` Worker secret of `brigade-api`.
