# Goals

`/goal <text>` keeps a teammate working until a goal is reached: a goal of work ("move to the new API,
tests green") or of outcome, which depends on the world ("10 demos booked by Friday", "+€500 MRR this
month", "top 10 on Google for a keyword", "+100 GitHub stars today"). The teammate turns it into a
contract, the person approves it in one click, and from then on Brigade runs the loop, the same for
every harness.

Code: `packages/contracts/src/goals.ts` (the contract, the notes the teammate gets, the limits),
`apps/api/src/goals.ts` (proposal, measurement, the loop, permissions, the banner's view),
`apps/api/src/chief-order.ts` (`goalNoteMayGo`, `withdrawGoalNotes`), `apps/runner/src/goal-measure.ts`,
the runner's `goalTools`, and `apps/web/components/goal-banner.tsx`.

## Why Brigade's, not the harness's

Claude Code (2.1.139 on) and Codex have a `/goal` of their own. Brigade does not use them: they cannot
see what a thread waits on (a ticket, a sub-thread, a review, CI, a wake-up) and would relaunch turns
for nothing instead of sleeping; they differ (Claude Code's is judged by a Haiku evaluator reading the
conversation, Codex's by the model saying it is done); and Brigade's interface cannot show them.
Brigade keeps the idea that works in Claude Code's, a judge apart from the worker, at its own level.

The runner rewrites `/goal` into words (`commandPrompt`, `GOAL_ASK`), so the harness never sees a
leading `/goal` it would take for its own command. A runner older than `GOAL_PROTOCOL` (54) does not,
so the API refuses `/goal` on it (`goalCommandRefusal`, in `promptThread`).

## The contract

`propose_goal` (only in a thread a person started, at the top) sends a `GoalContractInput`:

- the **outcome** and its **deadline**, and the **target** the measurement must reach;
- the **recipe** that measures it: a **command** run in the thread's working folder (its exit code, or
  the last number it prints), a read operation of an **App** account the teammate was granted (a number
  taken out of its answer: a value at a path, the length of a list, a sum), the ticked lines of a
  library **list**, or, when no figure is possible, the **person**'s judgment at the deadline;
- **permissions**: writes allowed in advance, each one operation of one App account with a cap a day
  and optional conditions on its arguments (`onlyWhen`), or for a merge, once every required check
  passed (`afterChecks`). Never a category;
- a **budget** in tokens of the person's subscription, counted as Usage counts them (input with the
  cache, and output), for the thread and its sub-threads since approval, and a longest duration;
- **stallTurns**: turns in a row without progress before it stops (6 by default).

The API checks it (`contractProblem`): a recipe's App read is a read, each permission a write the
teammate has read-write access to, a list exists, a command's computer can run it. One goal at a time
in a thread (`Goal_one_open_per_thread`): a new proposal replaces one nobody decided, and is refused
while one is under way. The banner shows it with **Approve and start** and **Decline**; to correct it,
the person writes what to change and the teammate proposes again. Approving needs who may write in the
thread, since the goal acts on its accounts.

## The measurement is never the teammate's

`measure` runs the recipe and keeps a `GoalMeasurement` (the series the banner draws):

- a command goes to the computer (`goal.measure`), which runs it as the teammate outside any turn and
  answers `goal.measured`; one never answered is failed by the minute's job;
- an App read goes through `handleConnectorCall` like a teammate's call (grant, account, logged), with
  the contract's fixed input, never a model;
- a list's ticked lines are counted from the file.

A goal is **achieved** only when a measurement meets the target. `complete_thread` is refused while a
goal is under way: its turn's end is measured, and the teammate is told the result.

## The loop

At the end of each turn of a thread with a goal under way (`noteGoalTurnEnded`, once per
`turn.completed` by its seq), Brigade measures, then (`afterMeasure`, `afterTurn`):

- the measurement meets the target: **achieved**, and the teammate is asked for its summary;
- past the deadline, the duration, the budget, or `stallTurns` turns without a better value: **ended**,
  with a summary too;
- the thread is not idle (waiting on a person, paused, at work) or anything is open in it (`openWork`:
  tickets, sub-threads not reported, reviews, its own wake-ups, pull requests, queued messages): it
  **sleeps**, as any thread does, and the turn that what is open brings is measured in turn;
- else Brigade **prompts the teammate again** with the latest measurement, the budget spent, the
  deadline, the turns without progress and, with a deadline, where the pace leads.

Recipes measured every so often (an App's, a list's, a command with `everyMinutes`) are also measured
between turns (`measureDueGoals`). A measurement that moves away from the target wakes a teammate that
sleeps, at most once in `GOAL_DRIFT_GAP_MS`. A deadline that passes is measured once more, then ends
the goal unless reached.

**Quota.** When a usage window of the thread's account is past `GOAL_QUOTA_RESERVE` (80%), the
relaunch waits until it resets (`heldUntil`): a goal never spends what the person's other threads need.

**Order with the person.** Every prompt of the loop is a goal note (`[Brigade goal <id> · <kind>]`), sent
as a wake-up (`sourceId` `goal:<id>:<kind>:<key>`) through the path Chief's answers take
(`keepInOrder`, docs/chief-answers.md): kept for the computer in order with the person's word, under the
thread's lock. The person's message, or their taking the thread in hand, withdraws relaunches and drift
wake-ups that have not gone (`withdrawGoalNotes`); a relaunch whose turn a person wrote after is never
kept (`goalNoteMayGo`), and their turn's end decides anew. A goal's start goes only while it is under
way, its end only once it is over. People see them as Brigade's notes, never as their own word.

Wake-ups in a row (`WAKEUPS_IN_A_ROW`) do not bind a thread with a goal under way: it bounds itself by
its budget, deadline and turns without progress.

## Permissions

A write that would ask a person (the teammate's policy, or the operation's own rule) goes without
asking when the active goal of its thread, or of its parent for a sub-thread working on a lever,
allows it (`goalCovers`, in `connector-calls.ts`): same account and operation, conditions met, checks
passed for a merge, and its share of the cap taken under a lock per permission, recorded in the audit
log whatever the call's result. Past the cap, outside the conditions, withdrawn, or with the goal
paused or over, it asks as it would without the goal. A permission never lifts a mailbox that waits for
a person, Chief's word, or the teammate's daily write cap.

## Limits no contract lifts

`GOAL_LIMITS`, in every start and relaunch: each platform's rules; no fake accounts and no account
posing as an ordinary user to promote (EU Directive 2005/29/EC, Annex I, point 22); no fabricated
engagement, such as stars, votes or reviews (point 23c); a teammate exchanging with people says it is
an AI (AI Act, Article 50(1)); never AI text disguised to get where AI text is not allowed: there, the
person posts in their own words. These are instructions, not guards.

## Strategy and the person

The start note tells the teammate how to work toward it (`GOAL_GUIDE`): list the levers, run several in
parallel in sub-threads, watch which move the measurement (`goal_status`), cut what does not; say early
when the projection misses the deadline; group what only a person can do in one prepared ticket at the
moment it weighs most; wait on the world with wake-ups.

## The banner

At the top of the thread (`GET /threads/:id`'s `goal`): the outcome, the latest measurement and its
curve, the target, the deadline, the budget spent, each permission with its use today, and **Pause**,
**Resume**, **Stop** and withdrawing a permission (`POST /threads/:id/goal/:goalId/:action`,
`DELETE …/permissions/:id`). Pausing, stopping and withdrawing only hold work back, so an admin may
too. A goal the person judges has **Reached** and **Not reached**. Stopped by a person, a goal takes no
more turn; otherwise, once over, the teammate writes its summary (`goal_report`: the final measurement,
what worked, what did nothing), which the banner shows and memory takes up as it does any thread.
