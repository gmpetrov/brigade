# Usage

Settings, Usage (`/app/usage`) shows the tokens the workspace's Claude and Codex
subscriptions spent, and what asked for them, so a process that spends more than
it should stands out. Brigade keeps the counts only, never what was said.

## What is counted

- **A teammate's turn, response by response, from the harness's own log.** Claude
  Code keeps a transcript of each session on the computer (its config directory,
  `projects/<the working directory>/`, subagents in `<session>/subagents/`), and
  Codex a rollout of each thread, its subagents' included (`sessions/`), with each
  model response's id, model and final counts. The runner reads them
  (`apps/runner/src/usage-logs.ts`, `usage-scan.ts`, run as the teammate's user on
  a cloud computer) after each stream of a turn and every 10 minutes, from where
  each was read up to, and sends `usage.responses`. The API keeps one `TokenUsage`
  row per response, by its id (`responseId`), with the most read of it (a Claude
  response's output grows as its transcript is written), so a response sent again
  counts once; the runner moves past what it read only once the API kept it. Only
  threads' working directories are read (`<BRIGADE_HOME>/teammates/<teammate>/threads/<thread>`,
  or `/home/<teammate's user>/threads/<thread>`), never a member's own sessions: a
  Codex rollout of another directory is skipped after its first line. Input counts
  the cache's reads and writes, output counts reasoning.
- **A turn's stream totals** (`usage.updated`, the AI SDK's totals at the end of
  each stream of a turn, stamped with the turn's account) are kept too, one row per
  event by the thread and the event's seq. From the first response a log gave for
  a thread, teammate and account on, those rows count the turn but not its tokens
  (`replaced`). They count only for turns no log covers: an older runner's, or
  before a thread's log begins. Measured against the transcripts, the stream's
  totals counted a turn split by background work twice (its last stream repeats
  the whole turn), missed subagents, and missed turns stopped or failed before
  their stream's end.
- **Runs outside a turn**, which spend the same subscriptions without showing in
  a thread: a quiet thread's memory (`memory`), a memory file laid out again
  (`tidy`), a new thread's title (`title`), a project's brief (`brief`) and an
  image for `generate_image` (`image`). The runner sends `usage.run`; the API
  keeps it only for an account of that runner's own computer.
- Each row copies in who and what it was for when it is stored: the teammate,
  the account and its member, the project, the routine, and the source. A
  thread deleted later keeps its tokens in the totals (its row loses only the
  thread's id).

Sources: a person's message and the turns after it (`member`), a trigger, a
routine's run (`schedule`), a child thread, a pull request review, a playbook's
run, then the runs outside a turn.

Keeping the tokens never holds a thread back: it is done after the thread's
events are stored, and not tried again when it fails.

## Who sees what

Owners and admins see the workspace's. A member sees what their own accounts
spent (an account is its member's alone), and no breakdown by member.

## Reading it

Most of a turn's tokens are its context read again from the cache at each step,
so input dwarfs output; a long thread costs more each turn than a short one.
Plans limit usage over time windows rather than in tokens: the avatar menu's
Usage row shows how much of each window is gone (from `Account.lastUsage`).

The tables give each row's tokens, its share, its turns (a routine's: its runs)
and its tokens per run, the figure to compare to spot a thread or routine that
spends far more each time than the others. A response is no turn: a model only
subagents ran shows tokens with no turns.

Not counted: what Claude Code spends outside its transcript (the guess at a
person's next message, its own small calls), about 2 to 3% of a thread's tokens.
Usage counts from 25 October 2026; when a runner first reads its computer's logs,
it sends what they still hold, which replaces the stream's totals of those turns.
