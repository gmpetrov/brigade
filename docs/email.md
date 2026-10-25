# Email

Brigade's own addresses for agents, on its mail domain (`MAIL_DOMAIN`, `mails.brigade.lol` in
production), received and sent through Resend: the **Email App** (`apps/api/src/mail/`,
`connectors/email.ts`, `routes/email.ts`). The decision record is
`Projects/Brigade/decisions/agent-email-spec.md` in the library.

## Addresses

- **An agent's address** (`MailAddress` kind `agent`): `riley@`. Off by default; an owner or admin
  turns the App on for the workspace (`POST /api/email/enable`), then each agent's address from its
  page (`POST /api/email/agents/:teammateId`).
  - `riley@` is used by Riley's threads without a project;
  - `riley.<project>@` by its threads in that project (`MailProject`: a project's slug, set the first
    time it is needed, kept when the project is renamed or deleted, never another project's);
  - `riley.<project>.<token>@` is a sign-up address a thread made (`MailAlias`, `email_new_address`).
    The token starts with a digit, so it never reads as a project.
- **A project's inbox** (kind `inbox`): a generated name (`support-lovarank-7f3k@`) that the
  project's own address is forwarded to. It may have a public address (`support@lovarank.com`) and,
  once its domain is verified (`MailDomain`, added to Resend for sending only), replies go out from it.
- **Names are unique across Brigade and never given again.** `MailAddress.name` is unique, and its
  row has no link that a workspace's, teammate's or project's deletion would remove: turned off, it
  keeps its name (`releasedAt`), and turned on again, the same agent gets it back. A taken name is
  offered as `name-2`, `name-3`… Names are 2 to 30 lowercase letters, digits and hyphens, never a
  reserved word (`support`, `admin`, `postmaster`…, `mail/names.ts`).
- **Each address is an account of the Email App** (a `Connection` of kind `email`, auth `brigade`:
  no credential, Brigade's Resend key). An agent's address is granted to that agent alone and cannot
  be granted to another; an inbox is used only in its project's threads, by the teammates given it
  (a rule's teammate gets it when the rule is made).

## Receiving

Resend's webhook (`POST /events/resend`, Svix-signed with `RESEND_WEBHOOK_SECRET`) applies to the
whole Resend account, which other products share: only recipients on `MAIL_DOMAIN` are kept, and
nothing of the others' mail is stored. Each box among the recipients gets one `MailMessage`, kept
at once (`status: pending`); its text, headers and SPF/DKIM/DMARC results are then read from Resend
(`GET /emails/receiving/:id`) and it is delivered, in the background. A minute tick tries again what
did not finish, waiting longer each time, and marks a mail failed after 8 tries. Calls to Resend go
through one queue at 4 a second (the account allows 10 for everyone).

Each mail goes to **one** place, in this order (`mail/inbound.ts`), kept in `route`, which is the
address's journal (`GET /api/email/addresses/:id/journal`):

1. **A thread waiting on it**: mail to a sign-up address while it waits (`awaited`, even machine
   mail), or a reply in a conversation the thread sent mail in (`ReplyWatch`, as for Gmail). It is a
   `Wakeup` of kind `reply`, fired at once, or handed to `email_wait` when the thread is waiting in
   that call. A delivery failure of the thread's mail comes back the same way (`bounce`).
2. **Its conversation's thread** (`conversation`): a thread a member's mail or a rule started for it.
3. **A member's request** (`member`): mail from a member of the workspace whose DKIM or DMARC passed,
   to an agent's address, starts (or continues) a thread for that member with that agent, in the
   variant's project, as if they had typed it.
4. **The address's rules** (`rule`): triggers `email.email_received` in their order
   (`Trigger.position`, `PUT /api/email/rules/order`). The first that matches takes it; an agent's
   rule watches its project's variant only.
5. **Its box** (`box`): read on demand with `email_list`; deleted after 30 days (`sweepMail`), but a
   sign-up's mail whose conversation has mail that stays: it marks the conversation as its thread's.

Before these: a copy of a reply a person sent from the mailbox itself (`own_copy`, its From is the
inbox's public address), the same `Message-ID` already delivered from another address of the
workspace (`duplicate`), a conversation that sent mail to threads 8 times within the hour (`loop`),
and Brigade's test mail (`test`, `X-Brigade-Test`). A rule past its threads for the day (`perDay`,
50 by default) leaves the mail in the box and opens one ticket (`cap`).

Who wrote it (`MailSender`): `member` (verified), `contact` (someone the workspace exchanged mail
with: they were written to, or their mail went to a thread; `Contact`, `ContactHandle`), `brigade`
(one of its own addresses), or `unknown`. The thread is told, with the contact's earlier threads.
A reply in a conversation the thread has gives it the new words only; `email_read` has the quote.

## Sending

`email_send` (a connector write) sends from the thread's box: the agent's variant, shown as
"Riley · Lovarank", or the inbox (its public address once verified). Before anyone is asked
(`Operation.check`) and again after a person changed the draft (`mail/outbound.ts`):

- a reply goes to its conversation's people only, unless `newRecipients` says so;
- the files are this thread's own; no secret in the text (`secretIn`);
- at most 100 mails a day from an address, 50 recipients, 10 files, 25 MB;
- no reply after someone already answered from the mailbox itself (`own_copy`).

A mail to anyone outside the workspace waits for a person (`Operation.asks`), unless the teammate's
`permissionPolicy.emailSends` is `allow` or a playbook's action lets it go; the approval card lets
the person edit the draft first (`ResolveApproval.edited`, `Operation.editable`). It is handed to
Resend scheduled 30 seconds ahead: until then it can be cancelled from the thread's panel
(`POST /api/email/messages/:id/cancel`) or with `email_cancel`. Resend's events (`email.sent`,
`delivered`, `bounced`, `failed`) give its `Message-ID` and its fate; a bounce wakes the thread.

## Gmail follows the same rules

Gmail's `email_received` is exclusive too: a mailbox's rules are tried in their order and the first
that matches takes the mail. On every trigger: a conversation a person took over stays theirs (the
event waits in the thread as a wake-up until they hand it back, `triggers.ts`), a conversation with
8 events within the hour is a loop, and a mailbox rule's threads stay out of the sidebar
(`Session.quiet`) until a person takes part or a ticket opens. A Gmail delivery failure in a watched
conversation wakes the thread.

## Agents' tools

`email_list`, `email_read`, `email_read_attachment`, `email_new_address`, `email_wait` (up to two
minutes in one call), `email_send`, `email_cancel`. Everything read is untrusted input.

## The Inbox

`/app/inbox`, under Home in the sidebar (`apps/api/src/inbox.ts`, `routes/inbox.ts`): every mail
the workspace's mailboxes received, across agents, projects and sources, in one list, one row per
conversation (a box's `conversationId`, a Gmail thread). Every source keeps its mail in the same
table, `MailMessage`, so one query lists, filters and pages them all; a new source (a chat) only
has to keep its messages there.

- **Sources**: Brigade's addresses, as they receive mail; and Gmail accounts shared with the
  workspace that their owner or an admin put in the Inbox (`Connection.inbox`, "Show in the Inbox"
  in the account's menu), as their inbox reader reads them (`src/mail/gmail-inbox.ts`: `connectionId`,
  `sourceId`, box `gmail:<connection id>`, without promotions and social). Such an account is read
  even without triggers. A member's own Gmail never shows, and a shared account stays out until
  someone puts it in: it may still hold personal mail.
- **A conversation** shows as its latest received mail (its head), with its number of mails. Its
  status is the head's, in the query (SQL, `DISTINCT ON` box and conversation, so paging is right
  whatever the view): `waiting` (nobody took it: `box`, `cap`, `loop`, or not delivered yet, and not
  done), `handled` (a thread has it, or its route needs nobody), `done` (`MailMessage.doneAt`, set on
  all its received mails; its next mail waits again). The sidebar counts conversations that wait,
  last 30 days.
- **Filters**: source, agent, project, words; a conversation shows when any of its mails matches
  (words: its senders, or the words of its mails received or sent).
  Pages of 50, newest first.
- **Opened** (by any of its mails' ids): each mail, received and sent from Brigade's address
  (Gmail's sent mail is not kept), oldest first, with its words (the quote apart), files,
  authentication. A sign-up's conversation, with the replies sent in it (they can quote its code),
  is shown and searched only for its thread's starter and admins; others see that it came.
- **Unassigned** (the page's word for `waiting`; `handled` shows as Assigned): the item says why
  nobody took it (from outside the workspace with no rule matching, a rule over its cap, a loop,
  not delivered yet) and, for Brigade's mail, lets an owner or admin add a rule on its mailbox
  (its project's variant, its agent first picked) for the mail that comes next.
- **Hand to**: a thread of the member with a teammate given the mailbox, in the item's project,
  with their note, the latest mail and the conversation's earlier ones. The mail then belongs to that thread (`route: handed`): Brigade's
  next mail in its conversation goes there; a Gmail conversation's reply wakes it (`ReplyWatch`).
