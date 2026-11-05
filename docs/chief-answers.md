# Chief for the person

Chief no longer reads each question a teammate ends on (#724 did, in a decision thread of its own
per question: noisy, and mostly "it's your call", since it knew less than the teammate asking).
It works for the person in two ways that take no turn on each question:

- **Their rules**, which every teammate working for them reads, so fewer questions are asked.
- **A daily pass**: once a day, Chief goes through what waits on them, settles what their rules
  settle, and leaves them the rest, prepared, on Today.

People call them **Your rules** and **Daily pass** (Preferences → Chief).

Code: `apps/api/src/chief-rules.ts`, `apps/api/src/chief-pass.ts`,
`apps/api/src/chief-answers.ts` (answers in the person's name), `apps/api/src/chief-order.ts`,
`packages/contracts/src/chief-answers.ts`, the runner's `rules`, `passInstructions`, `CHIEF_ANSWERS`
and `chiefTools`, and `apps/web/components/chief-pass.tsx`.

## Decisions

- **Off is Brigade as before.** Both are a member's (`Member.chiefRules`, `Member.chiefPass`, off
  and empty by default; `PUT /me/chief`). With no rules, the spec has none (`ThreadSpec.rules`);
  with the pass off, nothing runs and teammates are told nothing of Chief's answers
  (`ThreadSpec.chiefAnswers` false). Turned off, a pass at work stops: `setChief` marks theirs
  `failed` as it changes their row, in every workspace, every call of a pass checks it is still on
  (`passOn`), and an answer reads it under their row's lock, so one being kept as they turn it off
  is kept first or not at all; a retry's command too (`keepForPass`, by its commandId). `Member.chiefAnswers` and `chiefAuto` of #724 are no longer read,
  kept while an older API may (migrations only add), and were turned off for everyone first
  (`20261105233000_chief_answers_off_for_all`, #739).
- **Rules are a text in the person's words, not a library file.** `Member.chiefRules`, at most
  `CHIEF_RULES_MAX` characters, private to them and their teammates: one per person, whatever the
  workspace's folders. The person writes them in Preferences, with Chief in a thread (**Write them
  with Chief**, then `chief_rules` once they agree: only in a member's own thread of theirs, right
  after they wrote, never from what a routine, a trigger or an email brought in, as rules give
  their teammates leave to act), or takes the lines a pass proposes (`POST /me/chief/rules`; a
  refused line is kept in `chiefRulesRefused` and never proposed again). Each is taken or refused
  under their row's lock (`decideRule`): several at once all stay.
- **Every teammate working for the person reads them** (`specFor`): the thread's person is its
  asker (`askedBy`), or its starter when nobody asked (a routine's, a trigger's run); none in a
  thread several people ask in, a playbook's run, or a pass. The runner puts them in the
  instructions (`rules`): decide what they settle, say so in a line, ask the person only the rest;
  never their approval for what leaves Brigade. Instructions are written when a session starts:
  new rules reach a teammate from its next session.
- **The pass runs once a day per person and workspace, only when something waits.** From
  `CHIEF_PASS_HOUR` (7:00) in their timezone (`Member.timezone`, sent by their browser when they
  turn it on; UTC else), the minute's job (`chief-pass` in `jobs.ts`) claims their day
  (`ChiefPass`, unique by member, workspace and day), then lists what waits on them
  (`passItems`): the cards their teammates ended on in their own threads (top-level, theirs,
  idle, active in the last week, not put away, not Chief's own, not answered before), their failed
  threads, their tickets and pull requests, numbered, at most 30. Nothing waits: the pass is
  `idle`, and no turn is spent.
- **A pass is a thread of Chief's that no list shows** (`Session.chiefPassId`, quiet, archived once
  the pass is over, at medium effort on the person's account and the workspace's cloud computer,
  else their own machine; runners older than `CHIEF_PASS_PROTOCOL` get none). Its brief
  (`chiefPassBrief`) has their rules, the numbered items and their recent answers to cards
  (`recentAnswers`, the last two weeks), and what they refused. The brief is Brigade's, not the
  person's word: it summons none of the teammates the replies it quotes mention (`startThread`
  reads no mention in it), shows as Brigade's note, and only Chief answers it.
  Its only tools are `search_workspace`, `list_items` and its three calls, which act only on the
  brief's items, by number:
  - `chief_answer`: answers a question item in their name, citing the rule that settles it. Refused
    with no rules, on a design (always theirs), or once the pass reported.
  - `chief_retry`: tries a failed item's turn again (`retryThread`, as **Try again** does).
  - `chief_report`, once, last: what is still theirs with what Chief would do, notes across their
    threads, and at most a few rules to add. A pass that ends without it, or runs past 30 minutes,
    is `failed`: what it did stays.
- **An answer reaches the teammate as a report's wake-up** (`answerInTheirName`: a
  `ChiefDecision` of the pass kept with where it goes and its wake-up, in one transaction under the
  thread's lock, so never half made; one #724 left `pending` or `suggested` on the card is the
  pass's to settle, and the card is listed for it): superseded when the thread moved on
  since the question; left to the person after `CHIEF_ANSWERS_IN_A_ROW` (3) answers of Chief's
  there with no word from them; else fired at once, its text the very words a click would send,
  with why and the rule (`chiefAnswerMessage`). People see it as Brigade's note, "Chief answered for
  you", with **Mark as wrong** (`POST /threads/:id/chief/:decision/wrong`): the teammate is told to
  stop and undo (`chiefOverruledMessage`, steered into a running turn).
- **It is not the person's approval.** An answer puts its thread on Chief's word from an event
  on (`Session.chiefWordSeq`): from its question when Chief answers, under the thread's lock, and
  from the answer's own note once it reaches the teammate. Only a person's message after that
  event lifts it (`noteChiefAnswered`, which applies the thread's messages in their order, so a
  hook that runs late never lifts a newer mark), however many of Brigade's notes come meanwhile.
  While it holds (`onChiefsWord`), every App write asks the person whatever the teammate's access,
  except those that leave nothing outside and can be undone (`UNDOABLE_WRITES`: a branch, a pull
  request, marking one ready); a vault credential that would go without asking asks too
  (`credentials.ts`), with what the person mentioned or allowed in the thread still holding; and
  no routine is set up or changed (`schedules.ts`). The work handed on carries the mark: a
  sub-thread it starts (`startThread`'s `chiefWord`), a thread it starts for a teammate
  (`start_thread`, the same), a message to a sub-thread or a thread it started (`markOnChiefsWord`,
  from that thread's latest event on); not a review, which Brigade starts. Teammates are told the same
  of what Brigade cannot hold back: never deploy, publish, send, pay or delete another way (a
  command, a script) on Chief's word alone. That part is instructions, not a guard.
- **The thread reads an answer of Chief's before the person's word, or never.** Both reach its
  computer as commands kept before they are sent (`RunnerCommand`), and which comes first is
  settled as each is kept, in the transaction that keeps it, under the thread's lock
  (`chief-order.ts`, `keepInOrder`). The person's word (their message, taking the thread in hand,
  handing it back) supersedes Chief's answers still being made and withdraws those that have
  not gone to the computer: not kept yet, or kept while it was away and not sent since
  (`withdrawAnswers`). An answer of Chief's is kept only while its question is open, nobody has the
  thread in hand, and no word of the person's waits to be taken by the computer (`answerMayGo`);
  else it never goes, and its wake-up is cancelled. The workspace's hub keeps and sends these
  commands of one thread one at a time (`orderedThread`, `WorkspaceHub.inThreadOrder`): a message
  sent while an answer is on its way to the computer waits for it. They are kept at distinct
  instants, and before one goes on a connection, the thread's older ones still waiting for the
  runner that this connection has not had go first (`sendOrdered`, `keptBefore`): a computer that
  comes back gets an answer sent before the person's word first, whether its replay or their new
  message comes first (the runner takes a command once, however often it comes). Nothing is
  claimed in between: a process that stops at any point leaves the wake-up to fire again, and the
  answer is kept once (its command's id is the wake-up's). A dismissed card is a closed question
  (`questionClosed`), and dismissing settles Chief's decisions on it and withdraws its answers the
  same way (`noteChiefDismissed`).
- **Today shows the latest pass** (`GET /me/chief/pass`, `passView`, for 36 hours): what Chief
  settled in their name (each answer with where it stands and **Mark as wrong**), what is still
  theirs with what it would do (**Use it** sends its pick as theirs while the question is open,
  not a design's), what it noticed, and the rules it proposes (**Add to my rules**, **Not this
  one**). Its thread opens from **How Chief worked**.
