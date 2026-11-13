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
