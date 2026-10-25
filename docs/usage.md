# Usage

Settings, Usage (`/app/usage`) shows the tokens the workspace's Claude and Codex
subscriptions spent, and what asked for them, so a process that spends more than
it should stands out. Brigade keeps the counts only, never what was said.

## What is counted

- **A teammate's turn.** At the end of each stream of a turn the runner sends
  `usage.updated` with the AI SDK's totals (`TokenCounts`): input (with the
  cache's reads and writes in it, as both harnesses report it), output (with
  reasoning in it), the cache's share, and the model the harness named in its
  last step. It stamps the turn's account on the event. The API keeps one
  `TokenUsage` row per event, by the thread and the event's seq, so an event
  stored again counts once.
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
spends far more each time than the others.

Only usage since this was deployed is counted: older turns' events kept input
and output alone, and are not backfilled.
