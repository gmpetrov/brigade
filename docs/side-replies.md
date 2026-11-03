# Side replies (Asides)

A person who writes while their teammate's turn runs gets an answer at once, without the turn
being interrupted: a copy of the teammate's conversation answers on the side, and says what
becomes of the message. People see it as an **Aside** under their message. Code says "side
reply" (`message.side`, `side-replies.ts`), since "aside" already names a message read while a
teammate waits on its own ticket (`harness/aside.ts`, `ASIDE_PROTOCOL`).

## Decisions

- **A copy, not the turn.** A thread is one conversation, which runs one turn at a time. Steer
  puts a message into the turn at its next step; the side reply forks the conversation instead,
  so the turn is never interrupted or sidetracked. Claude Code forks the newest conversation in
  the thread's folder (the turn's) with `forkSession` and writes none (`persistSession: false`);
  Codex forks the folder's newest thread (`thread/list` by `cwd`) with `thread/fork`, ephemeral.
  Both through the bridges' patches, set by `BRIGADE_FORK_SESSION=1`
  (`patches/@ai-sdk__harness-*.patch`, tested in `apps/runner/test/claude-bridge-settings.test.ts`
  and `codex-bridge-fork.test.ts`).
- **It only reads.** Claude Code gets Read, Glob and Grep and nothing else; Codex's turn runs in
  its read-only sandbox, without network. Neither has Brigade's tools. Its effort is low and it
  stops after two minutes (`SIDE_REPLY_TIMEOUT_MS`).
- **It says what becomes of the message**, on its last line (`ROUTE: answer | steer | queue`,
  `parseSideReply`). answer: the message is read (`message.user` with `side`), runs no turn of
  its own, and the teammate is told the exchange as a note when its next turn starts (`sideNote`).
  steer: it goes into the running turn after `STEER_DELAY_MS`, unless its sender keeps it
  (`keep`). queue, or no route: it waits for the turn to end, as any message.
- **It knows the earlier asides of the turn.** Each forks the conversation as the turn has it,
  which never heard the asides before: so each side reply, and a message passed to the turn, is
  told the exchanges answered on the side during that turn (`Thread.sideLog`, `sideExchanges`,
  `withSideContext`). "Use the second one" then means something. The turn's next start tells it
  them as notes, and the log starts afresh.
- **A person can change it.** On a settled message, Steer gives it to the turn and `queue` has it
  run in a turn of its own; on one passed to the turn, Undo (`keep`). A settled message is no
  longer queued, and the runner keeps nothing of it: the API sends it again as it was queued
  (`settled`, so it gets no second side reply; `steer` for Steer), which works after a restart
  and any time later. A second click finds it queued and changes nothing.
- **Only when it costs nothing else.** A person's message to one teammate, while that teammate's
  turn runs, not when the turn only waits on its background work (the message goes in at once
  then), and only with memory to spare (`memoryRoom`). One at a time per thread: each waits for
  every one before it, even when one waiting is cancelled (`Thread.sides`). Its turn coming
  first, a cancel or an edit stops it; a failure leaves the message queued as before.
- **The thread shows it where it began**: the person's bubble and the aside under it, which the
  queue above the composer leaves out while the aside is under way or about to pass it on. Its
  reading carries the reply and route (`message.user`'s `side`), so a page or a timeline jump
  that starts there still shows the aside. A settled reading does not change the thread's
  status (`statusAfter`), its work time (`caps.ts`) or its timeline.
- **Its tokens** count as Asides in Settings › Usage (`UsageRunKind` side).
- **Runners from protocol 50** (`SIDE_REPLY_PROTOCOL`) send side replies and take `keep` and
  `queue`; the API refuses those actions to older ones, which never send one.
