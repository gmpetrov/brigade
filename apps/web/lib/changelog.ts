// What shipped in Brigade, for /changelog and its RSS feed. Brigade deploys each merge to main,
// so a release is a week of merged pull requests, named by the day it ends. Add a release at the
// top of RELEASES; its slug is that day (YYYY-MM-DD) and the page's address (/changelog/<slug>).
// From v0.4.0 each release carries the product's version, the root package.json's, whose minor
// goes up in the same pull request (docs/versions.md); the four before it have none. Brigade.app
// keeps its own version: a week it shipped, its section names it. Say only what the product does,
// as the landing page does, never what is behind a feature flag, and link the pull requests.

export type ChangelogItem = {
  title: string
  text: string
  /** Pull requests on gmpetrov/brigade. */
  prs?: number[]
}

export type ChangelogSection = {
  heading: 'Highlights' | 'Improvements' | 'Security' | 'Fixes' | 'Brigade.app'
  items: ChangelogItem[]
}

export type ChangelogRelease = {
  slug: string
  /** The product's version, "0.4.0", from v0.4.0 on. */
  version?: string
  title: string
  summary: string
  sections: ChangelogSection[]
}

export const RELEASES: ChangelogRelease[] = [
  {
    slug: '2026-11-27',
    version: '0.7.0',
    title: 'Chief’s first meeting, Profile and Give feedback',
    summary:
      'Onboarding ends in a first meeting with Chief: send your website or repository, and it does a first job and proposes your team. Each new teammate greets you with jobs to start with, and its model is picked right under its name. Change your name and picture in Settings › Profile, and send us feedback from your menu.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Chief’s first meeting',
            text: 'Onboarding ends in a thread with Chief, which speaks first: send your website or repository, or a line on what you build. In the same turn, Chief says what it understood, does a small first job you can see and proposes a team, and once you create it, each new teammate starts a first job in a thread of its own. The “What are you building?” screen is gone: your first workspace is made at once, named after you and renamable in Settings.',
            prs: [987, 972, 980],
          },
          {
            title: 'A teammate’s first meeting',
            text: 'Before its first thread, a teammate greets you with three jobs to start with, picked from its role, and Connect apps: a click starts the thread, or write your own in Something else. A new teammate is made in a dialog, and you land in a new thread with it.',
            prs: [982, 988],
          },
          {
            title: 'Teammates at hand',
            text: 'Pick a teammate’s model from the line under its name, in its panel and in a thread’s, saved at once. Teammate settings open in a dialog over the page you are on.',
            prs: [979, 981, 983, 984],
          },
          {
            title: 'Profile',
            text: 'Settings › Profile: change your name and picture and see your email. Your picture shows to the people you share an organization with, a name you chose survives a Google sign-in, and Delete my account moves here. The top row of your menu opens it.',
            prs: [989],
          },
          {
            title: 'Give feedback',
            text: 'Give feedback from your menu: write to the Brigade team and attach files. Documentation sits beside it.',
            prs: [985, 990],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Getting started in Brigade.app',
            text: 'Onboarding in Brigade.app links the computer at once and skips the questions; with a Claude or Codex login already on it, Chief starts next. Brigade.app signs in through your browser.',
            prs: [973, 961],
          },
          {
            title: 'Brigade Cloud when you need it',
            text: 'In a workspace without Brigade Cloud, a teammate’s Computer panel offers to wake it up on Cloud instead of an error, and a thread on your own computer offers Cloud in its panel. Onboarding’s one-line Cloud offer and the Inbox’s offer start Starter, at $15 a month.',
            prs: [978, 979, 996],
          },
          {
            title: 'Sign-in on a Mac',
            text: 'Sign in with Claude works on a Mac with the Claude app but no claude command, and a Claude Code or Codex login already on the Mac is found and becomes your default when yours does not work. Signing in again no longer adds a card each time, and Codex sign-ins work beside an older Codex. A new workspace’s Chief moves to its owner’s Claude or Codex login when that is the one the workspace has.',
            prs: [975, 976, 962],
          },
          {
            title: 'Macs behind a proxy',
            text: 'On a Mac that reaches the internet through a proxy, your shell’s or the system’s (as a VPN app sets), Claude Code and Codex go through it too.',
            prs: [992],
          },
          {
            title: 'Teammates',
            text: 'A teammate passes word to another thread it works in itself, an archived one included, instead of asking you to copy it there. Asked about Brigade, a teammate checks Brigade’s docs and code before answering.',
            prs: [947, 949, 954],
          },
          {
            title: 'Faster and calmer',
            text: 'Ask on a library file opens at once, and the side panel resizes smoothly beside a long library. The dashboard reads in Geist, and the message box loses its purple border.',
            prs: [970, 955, 951, 950],
          },
          {
            title: 'Site',
            text: 'A new landing page: the live demo plays its walkthrough as you scroll, and on a phone it runs inside a phone.',
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Your edits stay',
            text: 'A teammate can no longer save a library file over edits a person made since it last saved: the save is refused, and it starts again from the library’s copy.',
            prs: [969],
          },
          {
            title: 'Turns',
            text: 'A turn whose model goes quiet for 20 minutes while nothing runs stops with an error in the thread instead of hanging. A cloud computer whose disk was restored no longer leaves a thread unable to reach its own folder.',
            prs: [958, 960],
          },
          {
            title: 'Reconnecting accounts',
            text: 'Reconnecting an account from a ticket answers the ticket, in Brigade.app too, and Neon accounts show their names again.',
            prs: [948],
          },
          {
            title: 'Threads',
            text: 'A message sent just before leaving a thread no longer shows Not delivered when you come back, and a reply the dashboard cannot read no longer breaks the thread list.',
            prs: [971, 953],
          },
        ],
      },
      {
        heading: 'Brigade.app',
        items: [
          {
            title: '0.4.8',
            text: 'Opened from the website’s onboarding, Brigade.app signs in through your browser to the workspace the computer runs, and says whose teammates a new link would stop before it does.',
            prs: [956],
          },
          {
            title: '0.4.9',
            text: 'Connect in the setup checklist opens the dashboard in the app’s window, not your browser, and a new install opens the dashboard to sign in.',
            prs: [974],
          },
          {
            title: '0.4.10',
            text: 'On Windows, the installer and the app are signed, with CHAINDESK as their publisher.',
            prs: [993, 994],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-11-20',
    version: '0.6.0',
    title: 'Brigade.app everywhere, Snooze and Starter',
    summary:
      'Brigade.app now runs on macOS, Windows and Linux, and teammates work natively on a Windows PC. Snooze a thread until the time you pick, comment on a design right on its canvas, and plan routines on a calendar. Brigade Starter gives teammates a cloud computer for $15 a month.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Teammates on Windows',
            text: 'Teammates run natively on a Windows PC, with Brigade.app: install, turns, previews and computer use. Setup finds your own Claude Code or Codex login.',
            prs: [902, 911],
          },
          {
            title: 'Brigade Starter',
            text: 'A new plan: $15 a month gives your teammates a cloud computer for 100 hours a month. Cloud is now Max, with no hour limit, and a pricing page compares Free, Starter and Max.',
            prs: [928],
          },
          {
            title: 'Snooze',
            text: 'Do later becomes Snooze: put a thread away for an hour, three hours, until tomorrow or next Monday at 9:00, or a month, in your own time zone. It comes back unread at that time, or sooner if anything new arrives, and the sidebar’s Snoozed filter shows when each comes back. On Today, snooze a choice from its Needs you card.',
            prs: [843, 907],
          },
          {
            title: 'Design canvas',
            text: 'Press C, or Comment beside a thread, and click an element of a design to ask for a change to it, as in a preview. Drag a selected element to move it, or nudge it with the arrow keys. A teammate’s save shows at once, and a design beside a thread stays loaded while another thread shows.',
            prs: [909],
          },
          {
            title: 'Routines calendar',
            text: 'A Calendar view on the Routines page: drag a routine to move its runs, or click an empty slot to start a new one. Routines can also be grouped by the thread they report to.',
            prs: [903, 859],
          },
          {
            title: 'Computer use by accessibility',
            text: 'Teammates read an app’s interface as a tree and click, type, select or scroll through it without moving your pointer or taking your keyboard, on a Mac and, on a cloud computer, in their own browser’s prompts and dialogs. Keys reach Open and Save panels, and an app opens before the teammate goes on.',
            prs: [849, 856, 858, 874],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Settings over the page',
            text: 'Settings open as a dialog over the page you are on, and their search finds each setting inside its section and scrolls to it.',
            prs: [912, 913],
          },
          {
            title: 'A calmer Inbox',
            text: 'Newsletters, mail sent by machines and mail from senders you muted go to a new Other tab instead of To do, and no longer count in the sidebar. Mute or unmute a sender, or move a mail to To do, from the reader.',
            prs: [924],
          },
          {
            title: 'Everything shows at once',
            text: 'A pick, an answer, Allow or Deny shows as sent the moment you click it, in the thread and in Needs you. Pin, Snooze, Mark done, Archive, ticket rows and ticks move at once too, and an answer that did not go comes back as you wrote it.',
            prs: [864, 841],
          },
          {
            title: 'Teammates',
            text: 'A thread can have 10 sub-threads at work at once, up from 5. Teammates do a follow-up step themselves when one of their Apps or their browser can, rather than leave it to you, and no longer ask for an App you cannot add. A credential approval names the credential and why it is needed.',
            prs: [836, 863, 939, 933],
          },
          {
            title: 'Models',
            text: 'GPT-6.2 Sol and GPT-6.2 Astra join the model list, and Codex teammates on Default run GPT-6.2 Sol. Runners move to Claude Code 2.1.327 and Codex 0.169.1.',
            prs: [930, 936],
          },
          {
            title: 'Getting started',
            text: 'Chromebooks get their own steps to turn on Linux, the install works on Linux systems without xz, and the computer step offers Cloud in one clear button. Chief points to the docs for questions about Brigade, and the FAQ covers plans, the desktop app and self-hosting.',
            prs: [906, 935, 927, 925],
          },
          {
            title: 'Site',
            text: 'Comparison pages set Brigade beside Manus, Relevance AI, Claude Cowork, Perplexity Teammates and others, five new guides cover AI agents, and the landing page offers the download for your system.',
            prs: [835, 873, 861, 876, 916],
          },
        ],
      },
      {
        heading: 'Security',
        items: [
          {
            title: 'Sign-in and secrets',
            text: 'Brigade makes codes only to sign in, and the password routes it never used are closed. Codes never reach production logs, secrets MCP servers give Brigade are kept encrypted, and dependencies with known vulnerabilities are upgraded.',
            prs: [941, 942, 944],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Usage limits',
            text: 'A thread that moves to another account after Claude’s 5-hour or weekly limit keeps running, without a red dot.',
            prs: [893],
          },
          {
            title: 'Cloud computers',
            text: 'A cloud computer that a restart does not bring back moves to a new machine by itself, and stays signed in to Codex after a teammate refreshed its login.',
            prs: [940, 943],
          },
          {
            title: 'Sub-threads and tools',
            text: 'A sub-thread’s report reaches its parent even when Brigade restarted as it finished. A resumed thread learns its tools’ new definitions, and on Codex, a thread granted a new App keeps its conversation and tickets no longer hold the turn.',
            prs: [866, 862, 932, 934],
          },
          {
            title: 'Display',
            text: 'A working thread’s title stays readable on the current row of the sidebar, Markdown tables keep readable columns on narrow screens, and teammate settings stay as saved.',
            prs: [919, 938, 931],
          },
        ],
      },
      {
        heading: 'Brigade.app',
        items: [
          {
            title: '0.4.0 to 0.4.2',
            text: 'A new Brigade.app for macOS, Windows and Linux, which installed apps update into: it does all the menu-bar app did and opens the dashboard in a window of its own, without a title bar on macOS and Windows.',
            prs: [844, 845, 848, 915, 904],
          },
          {
            title: '0.4.3 to 0.4.5',
            text: 'The macOS app menu holds what the menu-bar menu does, the app shows notifications itself (turn them on in Settings, Notifications), ⌘F finds in the page, and Brigade.app stays in the Dock.',
            prs: [853, 855, 857, 860, 865],
          },
          {
            title: '0.4.6 and 0.4.7',
            text: 'Back and forward from the mouse buttons and ⌘← / ⌘→, teammates on Windows, computer use on Linux (X11 and GNOME), and a new install where your team moves in.',
            prs: [872, 902, 908, 911],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-11-13',
    version: '0.5.0',
    title: 'Goals, one file panel and Vercel',
    summary:
      'Type /goal and a teammate keeps working until Brigade measures that the goal is reached. Every library file opens in one panel, documents open at once, and Vercel joins the built-in Apps. Threads open the moment you click them, and mailbox rules can keep mail in the Inbox.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Goals',
            text: 'Type /goal and what you want reached. The teammate proposes how Brigade will measure it (a command, a figure from an App, the ticked lines of a list, or your own judgment), the target, a deadline, a budget and what it may do without asking. Once you approve, Brigade keeps it working until the measurement says the goal is reached, and a banner shows its progress with Pause, Resume and Stop.',
            prs: [828, 831],
          },
          {
            title: 'One file panel',
            text: 'Every library file opens in the document panel, from the Library, search, a thread or a mention: Markdown in the live editor, other text as text, the rest as a preview, with History, Share and Download. Documents open at once, say nothing while they save and warn only when offline, the path starts at the top of the library, and a minimized document folds into a round button under Preview.',
            prs: [790, 792, 795, 791, 787, 793, 813],
          },
          {
            title: 'Vercel',
            text: 'Vercel is a built-in App: add it from Add an App and sign in with Vercel.',
            prs: [809],
          },
          {
            title: 'Mailbox rules',
            text: 'Edit a mailbox rule in place, and give a rule Nobody as its teammate to keep the mail it matches in the Inbox for a person.',
            prs: [799, 800],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'A faster thread',
            text: 'A thread opens from the sidebar the moment you click it, even while others work, showing its end first. Take control and Hand back change at once, and on an iPhone, Back shows the page as you left it.',
            prs: [807, 811, 826, 797],
          },
          {
            title: 'Wake-ups in sub-threads',
            text: 'A sub-thread can set a wake-up to check on something later, and reports once it has.',
            prs: [820],
          },
          {
            title: 'Choices',
            text: 'A choices card is a compact list of soft tiles with numbered marks, and has a field to answer in your own words.',
            prs: [802, 803, 804, 805, 806],
          },
          {
            title: 'Emails in threads',
            text: 'A long email folds under Show more, and long links, in the Inbox too, show as the site they lead to.',
            prs: [825],
          },
          {
            title: 'Models',
            text: 'Claude Fable 5.2 joins the teammate model list, and runners move to Claude Code 2.1.319 and Codex 0.167.0.',
            prs: [821, 794],
          },
          {
            title: 'Pebbles',
            text: 'Each teammate’s pebble takes a shape of its own, drawn from the teammate, in the colours of Brigade’s cover.',
            prs: [819, 818],
          },
          {
            title: 'Demo and comparisons',
            text: 'The demo on the landing page has a fifth walkthrough that works through a list, and plays in Safari. Comparison pages set Brigade beside OpenClaw, Grok Bot, Lindy and others.',
            prs: [801, 808, 810, 823, 832],
          },
        ],
      },
      {
        heading: 'Security',
        items: [
          {
            title: 'Browser hardening',
            text: 'A strict Content Security Policy, a check against cross-site requests on writes, and signing out clears what the browser kept, so no draft reaches the next person to sign in.',
            prs: [814],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Phones',
            text: 'The Board stays within the screen on a phone.',
            prs: [796],
          },
          {
            title: 'Videos',
            text: 'A video or sound in a thread keeps playing after its link expires.',
            prs: [817],
          },
          {
            title: 'Teammates’ tools',
            text: 'A teammate’s first message in a new Claude Code process waits until Brigade’s tools are connected, so it no longer finds them missing.',
            prs: [815],
          },
          {
            title: 'First run',
            text: 'Clicking twice during onboarding no longer makes a second organization, and two turns starting together on a new computer no longer make one fail.',
            prs: [833],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-11-08',
    version: '0.4.0',
    title: 'Asides, Today and a faster thread',
    summary:
      'Write to a teammate while it works and it answers on the side, without stopping. Home becomes Today, with your rules and a daily pass from Chief. Threads stream smoothly and show what you send at once, and library files can be shared with a link.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Asides',
            text: 'Write to a teammate while it works: it answers on the side without stopping its turn, and its answers sit together in one card above the Working line.',
            prs: [646, 651, 661, 662, 678],
          },
          {
            title: 'Today',
            text: 'Home is now Today: a line that sums up the day, the routines that run today, and what needs you.',
            prs: [621, 603],
          },
          {
            title: 'Your rules and a daily pass',
            text: 'Write your rules in Preferences, under Chief. Once a day, Chief goes through what waits on you and says on Today what it would do with each item. For now it only recommends.',
            prs: [744, 768],
          },
          {
            title: 'A faster thread',
            text: 'Replies stream smoothly, a message shows the moment you send it, a new thread appears in the sidebar at once, and the Working line has a pebble whose eyes follow the step.',
            prs: [698, 648, 717, 722, 701],
          },
          {
            title: 'Share library files',
            text: 'Share a document, a design or any library file with a public link.',
            prs: [779],
          },
          {
            title: 'Dictation',
            text: 'Dictate a message in any message box, on Brigade Cloud.',
            prs: [691],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Keyboard in the sidebar',
            text: '⌥↑ and ⌥↓ walk the sidebar’s threads, and Enter folds or unfolds a row’s lists and sub-threads.',
            prs: [715, 725, 728],
          },
          {
            title: 'Mentions',
            text: 'Type @ to mention any thread, and open a thread from its mention.',
            prs: [730],
          },
          {
            title: 'Routines and Playbooks',
            text: 'Routines read as an agenda by next run, with each routine’s latest runs as dots. Playbooks have a page of their own.',
            prs: [711, 614],
          },
          {
            title: 'Board',
            text: 'Filters as pills, each card’s next wake-up, and its project beside the teammate.',
            prs: [612, 615, 669],
          },
          {
            title: 'Inbox',
            text: 'Filters move into the search box, mail reads as plain text with its HTML on demand, and a picker says who has a conversation.',
            prs: [602, 630, 655],
          },
          {
            title: 'New Apps',
            text: 'Expo and RevenueCat are built in. RevenueCat connects by signing in.',
            prs: [679, 667, 693],
          },
          {
            title: 'Lists and the editor',
            text: 'New workspaces start with a Getting started list, a file dropped on a line goes with it to its teammate, and the editor selects whole lines and drags them into toggles, as in Notion.',
            prs: [689, 738, 638, 748],
          },
          {
            title: 'Projects',
            text: 'A project is one page with its lists and what runs on its own, and its settings have a setup checklist.',
            prs: [600, 601],
          },
          {
            title: 'Getting started',
            text: 'Four quick questions during onboarding shape Chief’s first message.',
            prs: [726],
          },
          {
            title: 'Usage',
            text: 'Share the period’s usage as an image.',
            prs: [704],
          },
          {
            title: 'Signed out',
            text: 'When a turn fails because an AI account is signed out, sign in again from the thread.',
            prs: [652, 656],
          },
          {
            title: 'Tasks make way for lists',
            text: 'The Tasks board is gone: lists and threads do its job. Child threads are called sub-threads, and teammates’ email addresses are part of Brigade Cloud.',
            prs: [740, 644, 682],
          },
        ],
      },
      {
        heading: 'Security',
        items: [
          {
            title: 'Secrets and deletions',
            text: 'Secrets are masked in a thread’s steps before they are stored, and deleting a workspace or an account asks for a code sent by email.',
            prs: [685, 733],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Turns',
            text: 'A turn tried again after its process stopped keeps its message, and a turn no longer stays open waiting on background work that isn’t running.',
            prs: [599, 767],
          },
          {
            title: 'Previews',
            text: 'Previews keep running through runner updates, and one closed page no longer hangs a preview.',
            prs: [762, 743],
          },
          {
            title: 'Sessions',
            text: 'The browser’s session is renewed with the session itself, so you stay signed in.',
            prs: [710],
          },
        ],
      },
      {
        heading: 'Brigade.app',
        items: [
          {
            title: '0.3.4 to 0.3.11',
            text: 'A New thread shortcut (⌘⇧1) and a menu with the actions on top, Esc closes the screenshot window, Check for updates says what it found, no Dock icon, and a Workspace submenu to switch the Mac between linked workspaces. Teammates can run a command on the Mac through Brigade Computer Use.',
            prs: [623, 616, 607, 613, 695, 716, 636],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-11-01',
    title: 'Members and roles, docs, and lists in the sidebar',
    summary:
      'Invite people from the dashboard and give each a role, Viewer included. Brigade’s docs are online. Lists fold their threads in the sidebar, and teammates’ pull requests can merge on their own once ready.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Members and roles',
            text: 'Invite people from Settings › Members, change a member’s role or remove them. A Viewer sees the workspace and changes nothing.',
            prs: [553, 565, 564],
          },
          {
            title: 'Docs',
            text: 'Brigade’s documentation is online at brigade.lol/docs.',
            prs: [501, 531],
          },
          {
            title: 'Lists in the sidebar',
            text: 'A list’s threads fold under one row, and a list can be pinned with its threads. Lists show one row each, grouped by project. What remains of an item becomes a line of its own, and a problem the work shows is added to the list.',
            prs: [502, 505, 512, 519, 534],
          },
          {
            title: 'Auto-merge',
            text: 'Owners and admins can turn on Auto-merge in Preferences: a teammate’s pull request merges once it is ready. Off by default.',
            prs: [541],
          },
          {
            title: 'Board',
            text: 'The Board shows what moves across lists, threads and routines.',
            prs: [594],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Search',
            text: 'Search finds names despite a typo and ranks every kind of result together.',
            prs: [558],
          },
          {
            title: 'Files and media',
            text: 'Files up to 500 MB, audio attachments that play in the chat, library videos that play in the thread, and library images and designs shown under the message that mentions them.',
            prs: [575, 507, 580],
          },
          {
            title: 'Checklists',
            text: 'Round boxes, done lines that fade, notes under their line, and dragged lines that land where the drop line shows.',
            prs: [529, 546, 544, 560, 561],
          },
          {
            title: 'Library',
            text: 'A compact header with round New and Upload buttons, and a new file’s folder typed with suggestions.',
            prs: [513, 514, 525],
          },
          {
            title: 'Designs',
            text: 'Drag and pinch the design canvas on touch screens, and keep a design’s other options after a pick. Comments on a design and picks in a preview are sent together in one message.',
            prs: [510, 522, 589],
          },
          {
            title: 'Inbox',
            text: 'The Inbox shows what a teammate did with a conversation and how it ended.',
            prs: [574, 582],
          },
          {
            title: 'Apps',
            text: 'Teammates see which Apps they could use, and ask for one.',
            prs: [581],
          },
          {
            title: 'Smaller touches',
            text: 'Quicker tooltips, cut text that fades instead of ending in an ellipsis, and a Wake up button on a stopped computer.',
            prs: [528, 572, 590],
          },
        ],
      },
      {
        heading: 'Security',
        items: [
          {
            title: 'Acting for the right person',
            text: 'Teammates make and change only the schedules and triggers of the person their thread works for, and sub-agents can’t act for a thread.',
            prs: [586, 585, 593],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Usage and search',
            text: 'Usage counts each model response once, and searches made only of short words work again.',
            prs: [567, 587],
          },
          {
            title: 'Checkout',
            text: 'Stripe Checkout shows Brigade’s name.',
            prs: [550],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-10-29',
    title: 'Lists, cloud backups and a calmer sidebar',
    summary:
      'Checklists in the library become the backlog your teammates work through. Cloud computers are backed up and can move to a new machine. The sidebar shows sub-threads as a tree, and long threads get a timeline to jump through.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Lists',
            text: 'A checklist in a library document is a list people organize work with. Hand a line to a teammate: its thread and pull requests show on that line, and the line is ticked once the work is merged.',
            prs: [487, 496],
          },
          {
            title: 'Cloud computer backups',
            text: "A teammate's cloud computer is backed up, and can be replaced onto a new machine.",
            prs: [425],
          },
          {
            title: "Take over a teammate's browser from Home",
            text: 'When a teammate needs a person in its browser, take it over from Home and act on the whole computer. Messages queued meanwhile are kept and run once you hand back.',
            prs: [447, 443, 448],
          },
          {
            title: 'Sub-threads as a tree',
            text: 'Child threads sit under their parent in the sidebar, folded behind a caret. Long titles fade out instead of ending in an ellipsis, and the status dot moved to the right.',
            prs: [474, 476, 477, 453],
          },
          {
            title: 'Timeline beside long threads',
            text: 'Jump to any of your messages in a long thread from the timeline beside it.',
            prs: [458],
          },
          {
            title: 'Ask about a library file',
            text: 'Highlight text in a library file and ask a teammate about it right there. The library opens on Recent files.',
            prs: [457, 480],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Threads start at once',
            text: 'A new thread opens right away from every message box, without waiting on the server.',
            prs: [464, 481],
          },
          {
            title: 'One Working line',
            text: "A running turn's steps fold under a single Working line, with its time beside it.",
            prs: [482, 484, 485],
          },
          {
            title: 'Mail domains',
            text: "Add a domain's DNS records on Cloudflare in one click, and follow forwarding steps for your mail provider.",
            prs: [473, 472, 470],
          },
          {
            title: 'Inbox',
            text: 'Done opens the next email, arrow keys move through the list, and the Inbox says what a thread did when it did not reply.',
            prs: [424, 475],
          },
          {
            title: 'Pull requests and tickets',
            text: 'Teammates can take a pull request out of draft, and you can ask a teammate about its ticket without declining it.',
            prs: [462, 463],
          },
          {
            title: 'Your data, your call',
            text: 'Delete a workspace or your account yourself. Terms, privacy policy, data processing agreement and subprocessors are published.',
            prs: [451, 437],
          },
          {
            title: 'Previews',
            text: "A thread's preview stays open on the same page when you come back to it. On your own Mac, idle previews pause, and each thread's preview opens at its own <thread>.localhost.",
            prs: [461, 465, 427],
          },
          {
            title: 'Smaller touches',
            text: 'The time shows above a message that comes after a pause, panels open full screen on phones, and Skills has its own Settings section.',
            prs: [456, 452, 498],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Turns stopped for memory go on',
            text: 'A turn stopped by a server reset now carries on by itself.',
            prs: [493],
          },
          {
            title: 'Kept previews',
            text: 'A kept preview no longer loses its thread and shows "Thread not found".',
            prs: [467],
          },
          {
            title: 'Loading',
            text: 'The dashboard retries reading your account instead of loading forever, and design canvases no longer crash on iPhone.',
            prs: [455, 490],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-10-26',
    title: 'Brigade Cloud, the Inbox and code beside the preview',
    summary:
      'Brigade Cloud gives teammates a computer in the cloud. Teammates get email addresses and every mail lands in one Inbox. You can read and edit code right beside a thread’s preview, and memory and reviews were rebuilt.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Brigade Cloud',
            text: 'One subscription per workspace, $99 or €99 a month, paid with Stripe. Teammates work on a computer in the cloud, each with its own Docker, and each thread with its own ports.',
            prs: [307, 317],
          },
          {
            title: 'Email and the Inbox',
            text: "Teammates get their own addresses, and every email across teammates, projects and Gmail accounts lands in one Inbox, one row per conversation, with next steps, replies to approve and sending later. Mailboxes can use your workspace's own domain.",
            prs: [372, 373, 377, 386, 396, 399, 401],
          },
          {
            title: 'Code beside the preview',
            text: "Open the working folder's files next to a thread's preview, edit them, see changes since the last commit and revert them. Pick an element in the preview to mention it in your message or open its code.",
            prs: [334, 336, 353, 332, 362],
          },
          {
            title: 'Memory in layers',
            text: 'A core every thread loads, topics a teammate reads when the work calls for them, dated lines, and an archive.',
            prs: [277],
          },
          {
            title: 'Reviews',
            text: 'A pull request can get a review by another teammate in a child thread, set per project. Reviews go on while they converge, up to 8 looks, and a pull request shows commits pushed after the last look.',
            prs: [276, 305, 308, 310, 375],
          },
          {
            title: 'A public demo',
            text: 'The real dashboard on recorded data, at demo.brigade.lol and on the landing page, with walkthroughs to pick from.',
            prs: [323, 327, 402],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Try again',
            text: 'A failed turn is tried again on its own, or with Try again.',
            prs: [260],
          },
          {
            title: 'Stacked accounts',
            text: 'When a Claude or Codex account runs out mid-turn, the next one picks up the work. Settings › Usage shows what the subscriptions spend tokens on.',
            prs: [413, 376],
          },
          {
            title: 'Triggers from a thread',
            text: 'Teammates set up triggers from a thread, once an admin approves.',
            prs: [309],
          },
          {
            title: 'Teammate pages',
            text: 'Profile, Access, Activity and Limits tabs, one model picker for Claude and Codex, and a free-text title shown beside the name.',
            prs: [284, 294, 296],
          },
          {
            title: 'New Apps',
            text: 'Ahrefs and DataForSEO are built in, and Stripe connects by signing in instead of a pasted key.',
            prs: [359, 358, 302],
          },
          {
            title: 'More at once',
            text: 'A cloud computer runs 8 turns at once, and a thread says when its turn waits for a free slot.',
            prs: [419, 417],
          },
          {
            title: 'Workspace',
            text: 'Rename your workspace and give it a logo. A Preferences section in Settings, with the dark theme by default.',
            prs: [300, 301, 364],
          },
          {
            title: 'Threads',
            text: 'Next-message suggestions in the message box for Claude Code teammates, long messages folded under Show more, and Teammates and Projects folded and ordered your way in the sidebar.',
            prs: [278, 397, 405],
          },
        ],
      },
      {
        heading: 'Security',
        items: [
          {
            title: 'Sign-in and uploads',
            text: 'Sign in with a code sent by email, with rate limits. Uploads go straight to storage through signed URLs, never through the API.',
            prs: [414, 422, 380],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Computers and sessions',
            text: 'A thread says when its computer is restarting or offline, and a turn that fails inside its stream starts a new session.',
            prs: [290, 415],
          },
          {
            title: 'Previews on iPhone',
            text: "Previews load in Safari's and iPhones' preview pane, and a dev server's hot reload gets through.",
            prs: [352, 354],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-10-19',
    title: 'Computer use, Skills and Apps',
    summary:
      'Teammates can use a computer, learn a task from a recording, and reach many more Apps. Home lists what waits on you, and child threads let a teammate delegate work and get one report back.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Brigade.app and computer use',
            text: 'A menu-bar app for the Mac, with a setup checklist, Keep screen awake, and a screenshot shortcut that starts a thread. Teammates can use the computer it runs on.',
            prs: [89, 100, 138],
          },
          {
            title: 'Skills',
            text: "Brigade's own skills and your workspace's, run as /commands, proposed by teammates, or imported from GitHub.",
            prs: [76, 86, 121],
          },
          {
            title: 'Teach a task',
            text: 'Record a demonstration, and the teammate learns it as a skill.',
            prs: [108, 115],
          },
          {
            title: 'Apps',
            text: 'One App per service with several accounts in it; members connect their own. Add any MCP server by its URL. Cloudflare, Google Drive, Docs and Sheets, Neon, Supabase, Search Console and Analytics are built in.',
            prs: [105, 132, 114, 165, 169, 190],
          },
          {
            title: 'Home',
            text: 'Home lists what waits on you, and you decide it right there.',
            prs: [103],
          },
          {
            title: 'Child threads',
            text: 'A teammate delegates work beside a thread and gets one report back.',
            prs: [181, 232],
          },
          {
            title: 'Playbooks',
            text: 'Installable jobs, such as support, with autonomy set for each action.',
            prs: [230],
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Wake-ups',
            text: 'Teammates ask to be prompted again in their thread later, to check on a deploy or a CI run.',
            prs: [94],
          },
          {
            title: 'Tickets',
            text: 'Grant an App from the ticket that asks for it, or decline.',
            prs: [120, 160],
          },
          {
            title: 'Threads',
            text: 'New threads name themselves from the first message, messages can be copied, and videos up to 500 MB can be attached.',
            prs: [81, 75, 153],
          },
          {
            title: 'Runners',
            text: 'Runner updates hand running turns over instead of waiting for idle, and Computers shows whether each runner is up to date.',
            prs: [201, 166],
          },
          {
            title: 'Sidebar',
            text: 'Double-click to rename a thread, drag to reorder Pinned, and the threads filter is remembered.',
            prs: [240, 196],
          },
        ],
      },
      {
        heading: 'Fixes',
        items: [
          {
            title: 'Turns and approvals',
            text: 'An approval is carried out even when its turn lost its session, and a thread never looks busy while its events cannot get through.',
            prs: [172, 163, 167],
          },
          {
            title: 'Computer use and previews',
            text: 'Computer use types with the keys of the current keyboard layout, and a preview check never hangs.',
            prs: [90, 168],
          },
        ],
      },
    ],
  },
  {
    slug: '2026-10-14',
    title: 'The first teammates',
    summary:
      'Brigade’s first weeks: teammates that work in threads, a Chief who sets up the team, projects, a Tasks board, schedules, previews of your app, and designs on a canvas.',
    sections: [
      {
        heading: 'Highlights',
        items: [
          {
            title: 'Chief',
            text: "Every workspace's first teammate sets up the team and routes work to the others.",
          },
          {
            title: 'Projects',
            text: 'Group threads, tasks, a library folder and repositories. Threads in a project get its brief.',
            prs: [1],
          },
          {
            title: 'Tasks',
            text: 'Assigning a task starts the work, Backlog holds what is unassigned, and teammates manage the board.',
          },
          {
            title: 'Schedules',
            text: 'Teammates are prompted on a schedule you set.',
            prs: [3],
          },
          {
            title: 'Previews',
            text: 'A teammate starts your app in the thread and checks its pages before saying it is ready.',
          },
          {
            title: 'Designs and visuals',
            text: 'Designs open on a canvas of boards you can edit by hand, and teammates draw options, diagrams and charts in the thread.',
          },
        ],
      },
      {
        heading: 'Improvements',
        items: [
          {
            title: 'Messages mid-turn',
            text: 'A message sent while a teammate works is queued; steer with it, edit it or cancel it.',
          },
          {
            title: 'Mentions',
            text: 'Mention library files and projects in messages.',
          },
          {
            title: 'Pull requests',
            text: 'Close and reopen pull requests from the dashboard, and see how many are open in the sidebar.',
          },
          {
            title: 'Pebbles',
            text: 'Each teammate gets an animated pebble avatar of its own.',
          },
        ],
      },
    ],
  },
]

export const findRelease = (slug: string) => RELEASES.find((r) => r.slug === slug)

/** "v0.4.0: Asides, Today and a faster thread", or the title alone before v0.4.0. */
export const releaseName = (r: ChangelogRelease) =>
  r.version ? `v${r.version}: ${r.title}` : r.title

/** "October 29, 2026", the same wherever the page is built. */
export const releaseDate = (slug: string) =>
  new Date(`${slug}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
