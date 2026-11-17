import type { Guide } from '.'

export const openclawVsHermesAgent: Guide = {
  slug: 'openclaw-vs-hermes-agent',
  title: 'Hermes Agent vs OpenClaw: which one should you run in 2026?',
  metaTitle: 'Hermes vs OpenClaw (2026): honest comparison',
  description:
    'Hermes Agent vs OpenClaw, checked November 2026: memory and skills, chat apps, models, security, cost, Claude plans, migration, and which one fits you.',
  lead: 'Both are free, MIT-licensed agents you install yourself, and both now talk to you from about 30 chat apps. The real difference is the brain: Hermes Agent writes and improves its own skills as it works, while OpenClaw is a messaging gateway with the biggest ecosystem of skills that people write. Pick Hermes for an agent that learns your habits with less setup; pick OpenClaw for integrations, reliable schedules and a web dashboard.',
  published: '2026-11-15',
  updated: '2026-11-15',
  image: {
    src: '/guides/openclaw-vs-hermes-agent.webp',
    alt: 'Two friendly characters on either side of a balance scale: one with wings and a notebook, one with a wrench and a toolbox',
  },
  body: `
Most "Hermes vs OpenClaw" posts you'll find were written in the spring, when OpenClaw supported "50+ platforms" and Hermes "a few". That stopped being true months ago. We read both projects' docs and release notes again in November 2026, went through the Reddit threads where people who switched explain why, and wrote down what actually differs today.

Short version: **they converged on features and diverged on philosophy.**

## The 30-second answer

| | Hermes Agent | OpenClaw |
|---|---|---|
| Made by | Nous Research (venture-funded lab) | Peter Steinberger and the community, now the OpenClaw Foundation (nonprofit) |
| License | MIT | MIT |
| GitHub stars (Nov 2026) | about 264k | about 395k |
| Written in | Python | TypeScript (Node) |
| Chat apps | 28 in its docs (Telegram, Discord, Slack, WhatsApp, Signal, email, Teams…) | 33 in its docs (WhatsApp, Telegram, iMessage, Slack, Discord, Teams…) |
| Skills | Writes and patches its own skills after hard tasks | Skills written by people, shared on ClawHub |
| Memory | Agent-curated memory, session search, user modelling | Plain Markdown files (MEMORY.md, daily notes) with hybrid search |
| Where commands run | Local, Docker, SSH, Modal, Daytona, Vercel Sandbox | On the host unless you set up sandboxing |
| Hosted option | Nous Portal plans from $20 a month, with one always-on cloud agent | None official; a VPS or a third-party host |
| Moving between them | \`hermes import-agent openclaw\` imports an OpenClaw setup | No importer from Hermes |

If you only read one row, read **Skills**. It explains most of what people love and hate about each.

## How they think: a learning agent vs a gateway

A line from one of the Reddit roundups sums it up well: Hermes packages a gateway around a learning agent; OpenClaw packages an agent around a messaging gateway.

**Hermes Agent** calls itself "the agent that grows with you". After a complex task it can write a skill (a reusable instruction file in \`~/.hermes/skills/\`), and it patches those skills as it uses them. A background "Curator" keeps them tidy, and you can lock one so it stops changing (\`hermes curator lock <skill>\`) or require your review before any skill is written. On top of that sits memory the agent maintains itself, full-text search across past sessions and a model of you as a user.

**OpenClaw** started as a personal assistant you text. Its core is a gateway: one daemon that routes conversations from your chat apps to agents and sessions. Its memory is deliberately boring, in a good way: Markdown files on disk that you can open and edit, a nightly "dreaming" pass that consolidates them, and search on top. Its skills are written by humans and shared through ClawHub, the largest catalog of agent skills around.

What this means day to day:

- **Hermes gets better at your recurring tasks without you writing anything.** The flip side, raised again and again on Reddit, is that it rates its own work generously ("It always thinks it did a good job. ALWAYS.") and that self-written skills can drift or overwrite something you tuned by hand. Turn on the review queue if that worries you.
- **OpenClaw does exactly what its skills say, and you can read them.** The flip side is that you, or a stranger on ClawHub, have to write them, and its memory forgets more than people expect on long-running setups.

## Chat apps and where you talk to it

This used to be OpenClaw's big win. Today it's close to a tie: Hermes's messaging docs list 28 platforms and OpenClaw's channel catalog lists 33. Both cover Telegram, WhatsApp, Slack, Discord, Signal, Microsoft Teams, Matrix and email or SMS. OpenClaw has the edge on iMessage, X, Twitch and a voice-call plugin; Hermes covers more of the Chinese platforms (Feishu, DingTalk, WeCom, QQ).

OpenClaw also ships a real **web dashboard** and companion apps for macOS, iOS and Android. Hermes is mostly a terminal and your chat apps, though Nous now ships a desktop app for Mac and Windows. Several people on Reddit say the OpenClaw UI is why they stayed.

## Models and what you pay for them

Both are model-agnostic. Hermes signs you in to Nous Portal (one login for 300+ models, including Claude, GPT and open models) or works with OpenRouter, OpenAI, NVIDIA NIM or your own endpoint. OpenClaw has an even longer list of providers, including local runtimes like Ollama, LM Studio and vLLM.

The software is free either way. What you pay for is:

1. **The model.** For an always-on agent this is the big line. Heartbeats, long contexts and retries add up; people running OpenClaw around the clock on top models report bills in the hundreds of dollars a month.
2. **A machine.** Your own computer, a Mac mini, or a VPS. A 4 GB VPS for OpenClaw starts around $6 to $12 a month on promotional pricing, more at renewal.
3. **Or a hosted plan.** Nous sells Hermes Cloud through Nous Portal: Plus $20, Super $100 and Ultra $200 a month, each with model usage and one always-on cloud agent. OpenClaw has no official hosting, but plenty of companies sell managed OpenClaw from about $9 a month.

### Using your Claude plan

This is where many setups break, so it deserves its own section. In April 2026 Anthropic stopped letting Claude Pro and Max limits cover third-party agents like OpenClaw, then announced a separate credit for them in May, then paused that change in June. The rules moved several times, so check Anthropic's help center before you build on them.

What each project says today:

- **OpenClaw** recommends an Anthropic API key, and also offers a "Claude CLI" route that hands work to the official \`claude\` command on your machine, which draws on your signed-in plan.
- **Hermes** has a built-in Claude sign-in, but its own docs say it only spends purchased extra usage on Max and doesn't work on Pro. An experimental plugin routes through the Claude Code CLI instead.

If you want to run on the subscription you already pay for, the reliable path in both cases is the official Claude Code CLI. Hold on to that thought; we come back to it at the end.

## Security: the part people skip

OpenClaw had a rough 2026, mostly because it got popular fast:

- **Malicious skills.** In February, Koi Security audited ClawHub and found 341 malicious skills out of 2,857, most of them from one campaign that installed a macOS password stealer through fake "prerequisites". A later count reached 824. ClawHub now scans uploads with VirusTotal.
- **Exposed dashboards.** Early versions listened on every network interface by default. Security firms counted tens of thousands of OpenClaw control panels reachable from the internet, many of them vulnerable to a remote code execution bug that had already been patched.

None of that means OpenClaw is unsafe today if you keep it updated, bind it to localhost and only install skills you've read. It means **an always-on agent with your logins is a server, and you are its admin.**

Hermes has no comparable public incident, and its defaults are stricter: risky shell commands go through an approval mode (by default a second model judges the risk), a hard blocklist refuses things like \`rm -rf /\` even in "YOLO" mode, unknown chat users must pair with a one-hour code, and the Docker backend drops privileges. Its docs are honest that this "is defense-in-depth, not a hard sandbox". Note that Hermes can also install skills from ClawHub (through its scanner), so the supply-chain risk isn't OpenClaw-only.

## Setup and day-to-day maintenance

Both install with one command on macOS, Linux or WSL2, and both have a Windows installer.

- **Hermes** pulls in Python, Node and its other tools for you, then \`hermes\` walks you through picking a model. Reddit is fairly unanimous that "the setup is so much more streamlined".
- **OpenClaw** needs a recent Node (24.16 or newer), then \`openclaw onboard --install-daemon\`. It ships dated releases often, and "every update ships more bugs" is the most upvoted complaint in r/openclaw. Pin a version on anything you depend on.

Scheduling is solid in both. Hermes takes cron jobs in plain English and posts results to any chat. OpenClaw's automations (\`openclaw cron\`) keep a run history and can fire on webhooks or new Gmail messages, and its users trust them: "I actually trust the cron system to fire off my subagents."

## What people who tried both say

The most-cited analysis of r/openclaw (25 threads, 1,300+ comments, published by a company that sells OpenClaw hosting, so read it with that in mind) found roughly:

- **35%** stayed on OpenClaw, mostly for integrations, the dashboard and dependable schedules.
- **30%** switched to Hermes, mostly for easier setup, better defaults and skills that improve.
- **20%** run both, often Hermes for coding and research, OpenClaw for messaging-heavy automations.
- **15%** distrust Hermes, partly because of a wave of brand-new accounts praising it.

One OpenClaw hosting operator tested both as a coding agent over Telegram and wrote that Hermes won. Take that as one data point, not a verdict.

## Switching from OpenClaw to Hermes

Hermes has an importer: \`hermes import-agent openclaw\` (add \`--dry-run\` to preview). It brings over your OpenClaw setup, memory and skills included, and with \`--migrate-secrets\` your allow-listed API keys. People report small snags, such as paths that still point at OpenClaw's folder, so keep your OpenClaw setup until you've checked. There's no importer the other way.

## Which one should you pick?

**Pick Hermes Agent if:**

- you want an agent that learns your recurring work without you writing skills;
- you'd rather install in five minutes and tweak later;
- you want a paid, hosted version from the people who make it.

**Pick OpenClaw if:**

- you live in iMessage or need a specific integration from ClawHub;
- you want a web dashboard and schedules that fire like clockwork;
- you prefer memory and skills you can read and edit as plain files.

**Run both** if you have the patience: plenty of people do.

## Or: what if you need a team, not one assistant?

Hermes and OpenClaw are both built around one person and their assistant (or several separate assistants, through profiles or personas). If what you actually want is help running a company, say a support teammate on your inbox, a marketer on your content and an engineer on your repo, that are aware of each other and of your colleagues, the shape is different.

That's why we built [Brigade](/), an open-source app that gives your company a team of AI teammates. Each teammate is the official **Claude Code** or **Codex**, signed in with your own Claude or ChatGPT account, so the plan you already pay for does the work. Each one has a job, the Apps you give it (Gmail, GitHub, Stripe, Notion and more) and a memory shared with the rest of the team. For each teammate, you choose which actions in your Apps happen on their own and which wait for your yes, and everything that needs you lands in one list on your phone.

![A teammate in Brigade opened a pull request and waits for a merge](/guides/brigade-thread-pr.webp "A Brigade teammate builds a change and opens a pull request; you merge it with one click.")

It's free on your own computer, and Brigade Cloud (from $15 a month per workspace) gives teammates a computer that keeps working when yours is off. If you're weighing it against either project, we keep honest side-by-side pages: [Brigade vs OpenClaw](/compare/openclaw) and [Brigade vs Hermes Agent](/compare/hermes-agent).
`,
  faq: [
    {
      q: 'Is Hermes Agent better than OpenClaw?',
      a: 'Neither is better across the board. Hermes Agent is easier to set up and writes its own skills as it works, so it improves on recurring tasks. OpenClaw has more integrations, a web dashboard, very dependable schedules and memory you can read as plain files. Reddit is split roughly a third each way, with many people running both.',
    },
    {
      q: 'Is Hermes a competitor to OpenClaw?',
      a: 'Yes. Both are free, MIT-licensed personal AI agents that you run on your own machine or server and talk to through chat apps such as Telegram, WhatsApp and Slack. Hermes even ships an importer for OpenClaw setups.',
    },
    {
      q: 'Can I migrate from OpenClaw to Hermes Agent?',
      a: 'Yes. Run hermes import-agent openclaw (add --dry-run to preview first). It imports your OpenClaw setup, memory and skills included, and with --migrate-secrets your allow-listed API keys. Keep your OpenClaw install until you have checked the result.',
    },
    {
      q: 'Are Hermes Agent and OpenClaw free?',
      a: 'The software is free and MIT-licensed. You pay for the AI model you connect and for the machine it runs on. Nous Research also sells hosted Hermes plans from $20 a month; OpenClaw has no official paid plan, but third parties sell managed hosting.',
    },
    {
      q: 'Can I use my Claude subscription with Hermes or OpenClaw?',
      a: 'Only partly, and the rules changed several times in 2026. OpenClaw can hand work to the official Claude CLI, which uses your plan; Hermes says its built-in Claude sign-in only spends extra usage on Max. Running the official Claude Code CLI is the reliable way to use a Claude plan.',
    },
    {
      q: 'Which is more secure, Hermes or OpenClaw?',
      a: 'Hermes has stricter defaults (command approvals, a hard blocklist, pairing codes, hardened Docker) and no comparable public incident. OpenClaw had malicious skills on ClawHub and many exposed dashboards in early 2026. Either is reasonable if you update it, keep it off the public internet and only install skills you have read.',
    },
  ],
  sources: [
    { label: 'Hermes Agent on GitHub', url: 'https://github.com/NousResearch/hermes-agent' },
    {
      label: 'Hermes Agent docs: messaging platforms',
      url: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging',
    },
    {
      label: 'Hermes Agent docs: skills',
      url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/skills',
    },
    {
      label: 'Hermes Agent docs: security',
      url: 'https://hermes-agent.nousresearch.com/docs/user-guide/security',
    },
    { label: 'Nous Portal: Hermes Cloud plans', url: 'https://portal.nousresearch.com/cloud' },
    { label: 'OpenClaw on GitHub', url: 'https://github.com/openclaw/openclaw' },
    { label: 'OpenClaw docs: channels', url: 'https://docs.openclaw.ai/channels' },
    { label: 'OpenClaw docs: memory', url: 'https://docs.openclaw.ai/concepts/memory' },
    {
      label: 'OpenClaw docs: Anthropic provider',
      url: 'https://docs.openclaw.ai/providers/anthropic',
    },
    {
      label: 'OpenClaw docs: OpenClaw and Hermes Agent',
      url: 'https://docs.openclaw.ai/start/why-openclaw/openclaw-and-hermes-agent',
    },
    {
      label: 'Kilo: OpenClaw vs Hermes, what Reddit says',
      url: 'https://kilo.ai/articles/openclaw-vs-hermes-what-reddit-says',
    },
    {
      label: 'The Hacker News: 341 malicious ClawHub skills',
      url: 'https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html',
    },
    {
      label: 'SecurityScorecard: exposed OpenClaw deployments',
      url: 'https://securityscorecard.com/blog/how-exposed-openclaw-deployments-turn-agentic-ai-into-an-attack-surface/',
    },
    {
      label: 'Claude help center: the Agent SDK with your Claude plan',
      url: 'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan',
    },
  ],
}
