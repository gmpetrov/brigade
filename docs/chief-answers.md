# Chief answers for the person

The work goes down straight from a person to their teammates; the questions come back up
through Chief. When a teammate ends its reply on buttons (`replies`) or a choices card in a
member's thread, Chief reads the question before the person does and, in their name, picks the
answer their mandate settles, says "not now" to work outside their priorities, or leaves the
question to them with why. People call it **Chief answers for you** (Preferences → Chief).

Code: `apps/api/src/chief-answers.ts`, `packages/contracts/src/chief-answers.ts`, the runner's
`decisionInstructions` and `chiefTools`, and `apps/web/components/chief-take.tsx`.

## Decisions

- **Off is Brigade as before.** It is a member's preference (`Member.chiefAnswers`, on by
  default; `PUT /me/chief`). Off, no decision starts, the spec says nothing of it
  (`ThreadSpec.chiefAnswers` false, no `decision`), so every teammate's instructions are as they
  were, and questions wait for the person.
- **Where it reads.** A member's own top-level thread (origin `member`, no parent, no playbook,
  routine, trigger or mailbox rule, not archived or done, nobody in control), asked by its
  starter alone (`askedBy`), whose last turn ended idle on a card nobody answered or dismissed
  (`openAsk`). Never Chief's own questions, a sub-thread's (it reports), nor a question only in
  prose. A button that does Brigade's own action (merge, preview) is never one of the answers.
- **A decision is a sub-thread of Chief's** (`startDecision`), on the thread's computer and
  account, with a brief of its own (`chiefDecisionBrief`): the answers offered, the teammate's
  reply ending on them, the person's first request in the thread, their mandate
  (`chief/mandate.md`) and Chief's earlier decisions there. Its id is fixed with the decision
  (`ChiefDecision.childSessionId`), so a start tried again after a restart takes up the same
  thread, and its prompt (`chief:<decision>`) reaches it once. It runs at low effort, with no
  App, repository, roster or tool but `search_workspace`, `list_items` and `chief_decide`
  (`ThreadSpec.decision`); it is shown on the question, not among the thread's sub-threads
  (`Session.chiefDecisionId`), and it reports nothing: `noteChildEvents` hands its events to
  `noteDecisionEvents`, which settles it delivered and fails a decision it did not make. Runners
  older than `CHIEF_PROTOCOL` get none: the question waits for the person.
- **`chief_decide`**: a verdict (`answer`, `park`, `escalate`), the kind of question
  (`next_step`, `approach`, `priority`, or `taste` and `outside`, always the person's), the
  answer by its number, a reason, the mandate line or decision it goes by, and for `park` the
  work put off. Under the asking thread's lock (`applyDecision`): superseded when a message came
  in after the question; escalated; **answered** when the person lets Chief answer that kind on
  its own (`Member.chiefAuto`) and it has not answered `CHIEF_ANSWERS_IN_A_ROW` (3) times in the
  thread since the person last wrote; else **suggested**. A decision not made in
  `DECISION_MINUTES` (15) fails, each minute (`settleStaleDecisions`).
- **An answer reaches the teammate as a report's wake-up** (stored with the decision, fired at
  once, tried until it goes), its text the very words a click would send, with why and the
  mandate line (`chiefAnswerMessage`). People see it as Brigade's note, "Chief answered for you",
  never as their own message, with **Mark as wrong** (`POST /threads/:id/chief/:decision/wrong`):
  the teammate is told to stop and undo (`chiefOverruledMessage`, steered into a running turn),
  and the kind goes back to suggesting. A parked proposal's line goes to `chief/parked.md`, made
  when missing (`addListLine`), once the answer is given, or once the person takes the suggestion.
- **It is not the person's approval.** Once an answer of Chief's came in the thread, until the
  person writes there again (`actingOnChiefsWord`), every App write asks the person,
  whatever the teammate's access, except those that leave nothing outside and can be undone
  (`UNDOABLE_WRITES`: a branch, a pull request, marking one ready). Teammates are told the same of
  what Brigade cannot hold back: never deploy, publish, send, pay or delete another way (a
  command, a script, a credential) on Chief's word alone. That part is instructions, not a guard.
- **Suggestions earn autonomy, as playbooks' actions do.** A person's message after a suggested
  question measures it (`noteChiefAnswered`): their pick was Chief's (`agreed`: the same message,
  the same choice, or the option's words), or another (`disagreed`); only the person Chief answers
  for counts. Once `CHIEF_PROMOTION.agreed` (9) of their latest `CHIEF_PROMOTION.decisions` (10)
  answers to suggestions of a kind agreed, since they last refused, marked one wrong or changed the
  kinds themselves (`trustSince`), one ticket in that thread offers to let Chief answer that kind
  alone (`chiefPromotion`). Only that person decides it, and only they see it waiting on them
  (`waitsOn`). They can also switch a kind on or off themselves in Preferences.
- **The mandate is a library file Chief keeps with the person**, `chief/mandate.md`: what they
  aim for by project, the decisions that hold, what they always decide themselves. Chief may save
  in `chief/` wherever it may read (`teammateLibraryAccess`), unless a folder rule closes it. Chief
  writes the first one with the team on day 0 when it is on, offers a weekly look back
  (`create_schedule`, then `chief_decisions`), and Preferences offers **Write it with Chief** while
  there is none. Without a mandate, Chief answers only what the person's own words or remembered
  decisions settle.
- **What people see on a question** (`ChiefTake`): "Chief is reading this for you" while it
  decides; "Chief would pick …" with **Use it**, which sends that answer as theirs (not on a
  design, picked on its card); or "Chief leaves this one to you", with why and the answer it leans
  to. Each opens to the reason, the mandate line and Chief's decision thread.
