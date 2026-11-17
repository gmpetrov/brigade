import type { Guide } from '.'

export const openclawAlternatives: Guide = {
  slug: 'openclaw-alternatives',
  title: 'The best OpenClaw alternatives in 2026, by what you actually need',
  metaTitle: '11 OpenClaw alternatives (2026), grouped by need',
  description:
    'OpenClaw alternatives, checked November 2026: Hermes Agent, NanoClaw, ZeroClaw, Claude Code, Claude Cowork, Manus, n8n and more, grouped by why you switch.',
  lead: 'There is no single best OpenClaw alternative, because people leave OpenClaw for different reasons. If you want the same thing with less hassle, try Hermes Agent. If you want something small and locked down, look at NanoClaw or nanobot. If you mostly want to use your Claude plan, Claude Code and Claude Cowork now do much of what OpenClaw did. And if you need help running a company rather than a personal assistant, look at a team product like Brigade.',
  published: '2026-11-15',
  updated: '2026-11-15',
  image: {
    src: '/guides/openclaw-alternatives.webp',
    alt: 'Six colorful characters in a row, each holding a different tool, one of them under a spotlight',
  },
  body: `
OpenClaw is one of the most-starred projects on GitHub (about 395k stars in November 2026) and for good reason: it made "an AI that actually does things, from WhatsApp" real for a lot of people. It's also the project people most often tell us they're trying to leave.

Most "OpenClaw alternatives" lists on page one were written in March or April 2026. Since then Hermes Agent took off, Claude Code learned to take messages from Telegram and run on a schedule, Claude Cowork shipped to every paid Claude plan, and the rules for using a Claude subscription with third-party agents changed more than once. So we rebuilt the list from scratch.

**Full disclosure:** we make [Brigade](/), which is on this list. We put it where it fits, near the end, and we tell you when not to pick it.

## First: why are you leaving?

The right alternative depends on the itch. These are the reasons we see over and over, in r/openclaw and in our own inbox:

1. **"It costs too much to run."** Heartbeats, long contexts and retries burn tokens around the clock. And after Anthropic's April 2026 change, a Claude Pro or Max plan stopped covering OpenClaw's own Claude sign-in, so many people moved to pay-per-token.
2. **"I don't trust it with my accounts."** Malicious skills on ClawHub and tens of thousands of exposed dashboards made headlines in early 2026.
3. **"Every update breaks something."** It's the most upvoted complaint on r/openclaw.
4. **"It's heavy."** A full OpenClaw install uses well over a gigabyte of RAM; people want something that runs on a Raspberry Pi.
5. **"I need more than a personal assistant."** A team, shared work, approvals, colleagues.

Find your number, then jump to the matching section.

## The quick list

| Alternative | Best if you want | Open source | You pay for |
|---|---|---|---|
| Hermes Agent | The same idea, easier, and it learns | Yes, MIT | Models, or Nous plans from $20/mo |
| NanoClaw | A tiny, container-isolated agent | Yes, MIT | Models |
| nanobot | A small Python agent you can read in an afternoon | Yes | Models |
| ZeroClaw, PicoClaw | An agent for a Raspberry Pi or a tiny VPS | Yes | Models |
| Claude Code | Your Claude plan, coding first, now with chat channels and schedules | No | A Claude plan, from $20/mo |
| Claude Cowork | A hosted desktop agent for non-coding work | No | Included in paid Claude plans |
| Manus | A cloud agent that does whole tasks for you | No | A Manus plan |
| n8n | Automations you can see as a workflow | Source-available | Free to self-host, or n8n Cloud |
| Lindy | A hosted assistant for inbox and calendar | No | A Lindy plan |
| Brigade | A team of AI teammates for a company | Yes, MIT | Free on your computer, Cloud from $15/mo; AI on your own plan |

## If you want the same thing, with less hassle

### Hermes Agent

The closest alternative and the one most people actually switch to. Hermes Agent, from Nous Research, is also a free MIT-licensed agent you install yourself and talk to from Telegram, WhatsApp, Slack, Discord, Signal, email and about 20 other apps. The big difference: it writes and improves its own skills after hard tasks, so it gets better at your recurring work without you writing anything.

People who switched mostly cite the easier setup and better defaults (command approvals, a hard blocklist for destructive commands). People who stayed on OpenClaw cite its web dashboard, its integrations and schedules that never miss.

Moving is easy: \`hermes import-agent openclaw\` imports an OpenClaw setup. We compared the two in depth in [Hermes Agent vs OpenClaw](/guides/openclaw-vs-hermes-agent).

## If you want something smaller and safer

A whole family of "claws" appeared in 2026, each rewriting the OpenClaw idea in far less code. Fewer lines means less to audit and less to go wrong. They're younger and have fewer integrations, so expect to tinker.

- **NanoClaw.** A small TypeScript rewrite whose main idea is isolation: each chat or group runs its agent in its own container (Docker, or Apple's container tool on a Mac). It's the alternative security-minded people mention most.
- **nanobot.** A Python agent from the University of Hong Kong, about 4,000 lines, with memory and WhatsApp or Telegram. Popular with people who want to understand every line, or run it in their own cluster.
- **ZeroClaw and PicoClaw.** Written in Rust and Go respectively, built for tiny machines. Their own numbers put them at a few megabytes of RAM, against more than a gigabyte for OpenClaw. If you want an agent on a Raspberry Pi or a $5 VPS, start here.

The catch for all of them: you're still the admin of an always-on agent with your logins, and the model bill is still yours.

## If you mostly want to use your Claude plan

A lot of OpenClaw setups were really "Claude, but in WhatsApp, on a schedule". Anthropic has been closing that gap from its side, and its own tools run on the plan you already pay for.

### Claude Code

Claude Code is Anthropic's agent for the terminal, your editor, a desktop app and the web. It's coding-first, but in 2026 it picked up much of what people used OpenClaw for:

- **Channels** push messages from Telegram, Discord or iMessage into a running session.
- **Scheduled tasks** run in the cloud (with your computer off) or on your desktop.
- **Remote Control** and **Dispatch** let you check on or start work from your phone.
- **Agent teams** (still experimental) let several Claude Code sessions split a job. See our guide to [Claude Code agent teams](/guides/claude-code-agent-teams).

It runs only Claude models, and it's an Anthropic product, not open source. Plans start at Pro, $20 a month. For a full side-by-side, see [OpenClaw vs Claude Code](/guides/openclaw-vs-claude-code).

### Claude Cowork

Cowork is Claude Code's sibling for non-coding work: give it a goal and it works across your files, apps and browser, then hands back the result for review. It runs scheduled tasks, takes work from your phone, and is included in every paid Claude plan (it just uses up your limits faster than chat). It's the closest thing to "OpenClaw without the server" if your assistant does office work. No listicle we found even mentions it.

## If you want someone else to run it

- **Manus.** A cloud agent you hand whole tasks to (research, slides, small apps). Nothing to install, but you can't self-host it and you pay per plan and credits.
- **Lindy.** A hosted assistant focused on inbox, calendar and meeting follow-ups. Good if your OpenClaw mostly sorted email.
- **n8n.** Not an agent so much as a workflow tool with AI agent steps. If you want to *see* exactly what runs when, a canvas beats a chat. You can self-host it for free for internal use (its license is source-available, not open source) or use n8n Cloud.
- **Managed OpenClaw.** If you like OpenClaw itself and just hate running it, several hosts sell one-click or managed OpenClaw from about $6 to $12 a month. You keep the software and lose the sysadmin work, though not the model bill.

## If you need a team, not an assistant

Every option above is built around one person and their assistant. If you're running a company, the problems change: you want a support agent on the inbox, a marketer on content, an engineer on the repo, each with its own job and access, aware of each other and of your colleagues, and you want the risky actions to wait for a human.

That's what [Brigade](/) is for. It's an open-source app (MIT) that gives your company a team of AI teammates:

- **Each teammate is the official Claude Code or Codex**, signed in with your own Claude or ChatGPT account. The plan you already pay for does the work; Brigade never bills you for AI usage.
- **Each one has a job, its own computer and the Apps you give it**: Gmail, GitHub, Stripe, Notion, Linear and more, plus any MCP server.
- **They share a memory and a library** of your company's documents, and your colleagues work in the same threads.
- **You stay in control:** for each teammate you choose which actions in your Apps (an email, a refund, a merge) go on their own and which wait for your yes, and every request lands in one list on your phone.
- **They start on their own**, from a schedule or an event like a new email or a failed payment.

![Brigade's home screen with the decisions waiting on you](/landing/demo-light.webp "Brigade's home: threads, teammates, and the decisions waiting on you, in one place.")

It's free on your own computer, and Brigade Cloud (from $15 a month per workspace) gives your teammates a computer that keeps working when yours is off.

**Don't pick Brigade if** you want one personal assistant inside WhatsApp or Telegram (Brigade has its own app, on the web and your phone, and with Cloud an email address per teammate), or if you want to run local or arbitrary models (Brigade runs Claude Code and Codex). Hermes Agent or one of the small claws will suit you better. Our [Brigade vs OpenClaw](/compare/openclaw) page goes through the differences line by line.

## How to choose in two minutes

- Same idea, less friction: **Hermes Agent**.
- Security or tiny hardware: **NanoClaw**, **nanobot**, **ZeroClaw** or **PicoClaw**.
- Use the Claude plan you already pay for, mostly for code: **Claude Code**. Mostly for office work: **Claude Cowork**.
- Nothing to install: **Manus** or **Lindy**.
- Visible, auditable automations: **n8n**.
- A team that runs parts of your company, with approvals: **Brigade**.
`,
  faq: [
    {
      q: 'What is the best alternative to OpenClaw?',
      a: 'For the same kind of self-hosted personal agent, Hermes Agent is the most popular switch: free, MIT-licensed, easier to set up, and it improves its own skills. For security or small hardware, NanoClaw, nanobot, ZeroClaw and PicoClaw are lighter rewrites. To use a Claude plan, Claude Code and Claude Cowork cover much of what OpenClaw did.',
    },
    {
      q: 'What are some agents similar to OpenClaw?',
      a: 'Hermes Agent, NanoClaw, nanobot, ZeroClaw, PicoClaw and IronClaw are open-source agents built around the same idea. Claude Code, Claude Cowork, Manus and Lindy are hosted or proprietary agents that cover similar jobs.',
    },
    {
      q: 'Is there an OpenClaw alternative that works with a Claude subscription?',
      a: 'Yes. Claude Code and Claude Cowork are Anthropic’s own agents and run on Pro, Max and higher plans. Brigade runs the official Claude Code signed in with your own account, so your plan covers the work too.',
    },
    {
      q: 'Is there a lighter alternative to OpenClaw for a Raspberry Pi?',
      a: 'ZeroClaw (Rust) and PicoClaw (Go) are built for small machines and report memory use of a few megabytes, against more than a gigabyte for a full OpenClaw install. nanobot is a small Python option.',
    },
    {
      q: 'Is there an OpenClaw alternative for teams?',
      a: 'Most OpenClaw alternatives are personal assistants. Brigade is built for a company: several AI teammates with jobs, shared memory and threads with your colleagues, and one list of the actions waiting for a person’s approval. It is open source and free on your own computer.',
    },
  ],
  sources: [
    { label: 'OpenClaw on GitHub', url: 'https://github.com/openclaw/openclaw' },
    { label: 'Hermes Agent on GitHub', url: 'https://github.com/NousResearch/hermes-agent' },
    { label: 'PicoClaw on GitHub', url: 'https://github.com/sipeed/picoclaw' },
    {
      label: 'It’s FOSS: OpenClaw alternatives',
      url: 'https://itsfoss.com/openclaw-alternatives/',
    },
    { label: 'Claude Code overview', url: 'https://code.claude.com/docs/en/overview' },
    { label: 'Claude Cowork', url: 'https://claude.com/product/cowork' },
    { label: 'Claude pricing', url: 'https://claude.com/pricing' },
    { label: 'n8n Sustainable Use License', url: 'https://docs.n8n.io/sustainable-use-license/' },
    {
      label: 'TechRadar: you’ll need to pay to use OpenClaw now',
      url: 'https://www.techradar.com/pro/bad-news-claude-users-anthropic-says-youll-need-to-pay-to-use-openclaw-now',
    },
    {
      label: 'The Hacker News: 341 malicious ClawHub skills',
      url: 'https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html',
    },
    {
      label: 'Kilo: OpenClaw vs Hermes, what Reddit says',
      url: 'https://kilo.ai/articles/openclaw-vs-hermes-what-reddit-says',
    },
    {
      label: 'Hostinger: best OpenClaw hosting',
      url: 'https://www.hostinger.com/tutorials/best-openclaw-hosting/',
    },
  ],
}
