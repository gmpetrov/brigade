// What shipped in Brigade, for /changelog and its RSS feed. Brigade deploys each merge to main,
// so a release is a week of merged pull requests, named by the day it ends. Add a release at the
// top of RELEASES; its slug is that day (YYYY-MM-DD) and the page's address (/changelog/<slug>).
// Say only what the product does, as the landing page does, and link the pull requests.

export type ChangelogItem = {
  title: string
  text: string
  /** Pull requests on gmpetrov/brigade. */
  prs?: number[]
}

export type ChangelogSection = {
  heading: 'Highlights' | 'Improvements' | 'Security' | 'Fixes'
  items: ChangelogItem[]
}

export type ChangelogRelease = {
  slug: string
  title: string
  summary: string
  sections: ChangelogSection[]
}

export const RELEASES: ChangelogRelease[] = [
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
            text: 'Select text in a library file and ask a teammate about it, from the file. The library opens on Recent files.',
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

/** "October 29, 2026", the same wherever the page is built. */
export const releaseDate = (slug: string) =>
  new Date(`${slug}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
