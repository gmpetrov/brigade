import type { Guide } from '.'

export const selfHostedAiAgents: Guide = {
  slug: 'self-hosted-ai-agents',
  title: 'Self-hosted AI agents in 2026: options, real costs and the risks nobody lists',
  metaTitle: 'Self-hosted AI agents (2026): options and real costs',
  description:
    'What a self-hosted AI agent really is, the main options (OpenClaw, Hermes Agent, n8n, Ollama…), hardware and model costs, and the security risks.',
  lead: 'A self-hosted AI agent is agent software (the loop, memory, tools and chat connections) running on a computer you control, usually calling a cloud model like Claude or GPT. Fully local setups, with the model on your own hardware too, are rarer and weaker but completely private. Self-hosting buys you control and lower software costs; you pay for it in model bills, maintenance and security work.',
  published: '2026-11-15',
  updated: '2026-11-15',
  image: {
    src: '/guides/self-hosted-ai-agents.webp',
    alt: 'One character tinkering with a small home server and cables, another relaxing on a cloud next to a glowing computer',
  },
  body: `
"Self-hosted AI agent" became one of the fastest-growing searches of 2026. Searches for it went from a few dozen a month to tens of thousands over the summer, Mac minis sold out in the spring, and Hostinger now sells a VPS template for OpenClaw. Most of the pages that rank for it are lists of tools. This guide tries to answer the question underneath: **should you run your own agent, and what does it really take?**

## What "self-hosted" actually means

The phrase covers three quite different setups:

1. **Your agent, a cloud model.** The agent software (its loop, memory, tools and the bridges to your chat apps) runs on your laptop, a Mac mini or a VPS, and it calls Claude, GPT or another hosted model. This is what most people mean in 2026: it's how OpenClaw and Hermes Agent are usually run.
2. **Fully local.** The agent *and* the model run on your hardware, with Ollama, LM Studio or LocalAI serving an open-weight model. Your prompts never go to a model provider, though the agent's own tools (a web search, an email it sends) still reach the internet.
3. **A self-hosted platform for a team.** A server you deploy for many people to build and run agents or chat: Dify, n8n, Open WebUI, AnythingLLM.

One thing to be clear-eyed about: in setup 1, **your data still goes to the model provider** every time the agent thinks. Self-hosting the agent gives you control over the tools, logs and credentials, not over the model.

## The main options

| Option | What it does | License |
|---|---|---|
| OpenClaw | Always-on personal agent you text from WhatsApp, Telegram, iMessage and ~30 other apps | MIT |
| Hermes Agent | Personal agent from Nous Research that writes its own skills as it works | MIT |
| NanoClaw, nanobot, ZeroClaw | Small rewrites of the OpenClaw idea, easier to audit or to run on tiny hardware | Open source |
| n8n | Workflow automation with AI agent steps, on a visual canvas | Sustainable Use License (source-available, not open source) |
| Dify | Visual builder for LLM apps, agents and retrieval | Apache 2.0 with extra conditions (no competing multi-tenant SaaS, keep the logo) |
| Open WebUI | Self-hosted ChatGPT-style interface for local or API models | BSD-based license with a branding clause |
| Ollama, LM Studio, LocalAI | Run open-weight models locally behind an OpenAI-compatible API | Varies, mostly permissive |
| Claude Code, Codex CLI | The model makers' own agents, which you can install on your own machine or server | Proprietary (Codex CLI is open source) |

If you plan to host something for clients or a big team, read the license. "Open source" on a landing page doesn't always mean you can resell it or remove the branding.

For a deeper look at the two most popular personal agents, see [Hermes Agent vs OpenClaw](/guides/openclaw-vs-hermes-agent) and our list of [OpenClaw alternatives](/guides/openclaw-alternatives).

## Hardware: less than you think, unless the model is local too

An agent that calls a cloud model needs very little computing power. Most of its time is spent waiting for the model.

- **Your own computer** works, as long as it stays on. Laptops that sleep are the classic way an "always-on" agent goes quiet.
- **A Mac mini** became the default always-on box this year, for its low power draw, macOS-only integrations like iMessage, and unified memory if you want to try local models. Demand was strong enough that Apple said in the spring that some configurations could stay sold out for months.
- **A VPS** with 2 vCPUs and 4 GB of RAM is the usual recommendation for OpenClaw or Hermes. Promotional prices start around $6 to $9 a month at Hostinger, and roughly double at renewal. Hetzner raised its prices twice in 2026, so ignore older "under $5" figures. Budget for the renewal price.
- **The official Claude Code CLI** needs 4 GB of RAM and runs on macOS, Windows and common Linux distributions, so the same small server can run it.

**Running the model locally is another story.** Small models fit on a gaming GPU, but the open models that come close to Claude or GPT at multi-step tool use need serious memory. People report setups from about $2,000 to well into five figures.

## Local models vs cloud models

- **Quality.** Open models are now good at bounded, well-specified tasks. On long agent runs with many tool calls, frontier cloud models still win, and that's exactly the kind of work an agent does.
- **Cost.** For one person or a small team, a subscription or an API is still cheaper than buying hardware that runs a near-frontier model.
- **Privacy.** Fully local is the only setup where your prompts and data never go to a model provider; only what the agent's tools send (a search, an email) leaves your machine. If that's a hard requirement (health data, client contracts), it's worth the trade.

The pragmatic setup many people land on is hybrid: routine work on a local model, hard work sent to a frontier one.

### What about my Claude or ChatGPT subscription?

This catches a lot of people out. In April 2026 Anthropic stopped letting Claude Pro and Max limits cover third-party agents like OpenClaw; their Claude sign-ins moved to paid extra usage or an API key. Anthropic later announced, then paused, a separate credit for such tools, so check its help center for the current rules. Its developer docs also say third-party products may not offer a claude.ai login unless Anthropic approved them.

What doesn't change: **the official Claude Code CLI runs on your own machine or server, signed in with your Pro, Max, Ultra or Team plan.** If you want a self-hosted agent that spends the subscription you already pay for, running the official CLI is the dependable way to do it.

## Security: the numbers

A self-hosted agent is a server holding your email, calendar, files and API keys, which takes instructions from text it reads. 2026 showed what happens when that's set up casually:

- **Exposed dashboards.** Early OpenClaw versions listened on every network interface. Researchers counted between roughly 20,000 and 135,000 OpenClaw instances reachable from the internet, depending on the firm and the date, many missing authentication or vulnerable to a remote code execution bug that had already been fixed (CVE-2026-25253, rated 8.8).
- **Malicious add-ons.** An audit of ClawHub, OpenClaw's skill registry, found 341 malicious skills out of 2,857, most of them installing a macOS password stealer.
- **Prompt injection.** Any agent that reads your email or the web can be steered by instructions hidden in that text.
- **Plain mistakes.** In February, an AI safety director at Meta watched OpenClaw bulk-delete her real inbox and ignore her messages to stop. She traced it to a long context dropping her "ask before acting" instruction.

The lesson from that last one matters most: **a rule written in a prompt is not a control.** Actions that can't be undone (sending email, deleting data, moving money) need a hard approval step outside the model.

## The maintenance you sign up for

If you self-host, you own:

- operating system and agent updates (some fix security holes, some break things);
- keeping the agent off the public internet, or behind real authentication;
- TLS, a reverse proxy and a firewall if you expose anything;
- storing API keys and OAuth tokens safely;
- reviewing every skill or plugin before you install it;
- backups of the agent's memory and settings;
- keeping the box awake and online;
- watching your model spend, because an always-on agent bills while you sleep.

None of it is hard on its own. Together it's a part-time job, which is why a middle ground exists.

## The middle ground: open source, hosted for you

You don't have to choose between "my own server" and "a black box". Plenty of projects keep their code open, so you can read it and self-host whenever you want, and also sell a hosted version: managed OpenClaw from several hosts, Hermes Cloud from Nous Research, n8n Cloud, Dify Cloud.

That's the model we picked for [Brigade](/), an open-source app (MIT) that gives your company a team of AI teammates:

- **Run it on your own computer for free**, or **self-host the whole stack** on one server with Docker Compose, or on Cloudflare.
- **Or use Brigade Cloud** (from $15 a month per workspace), which gives each teammate a computer of its own that keeps working when yours is off.
- **Each teammate is the official Claude Code or Codex**, signed in with your own Claude or ChatGPT account, so the subscription you already pay for does the work and Brigade never bills you for AI usage.
- **Approvals live outside the model.** For each teammate, you choose which actions in your Apps (an email, a refund, a merge) go on their own and which wait for your yes, and everything that needs you lands in one list on your phone.

![A Brigade teammate opened a pull request in a thread](/guides/brigade-thread-pr.webp "A Brigade teammate builds a change and opens a pull request; you decide when it merges.")

Brigade isn't a personal assistant inside WhatsApp, and it doesn't run local models. If that's what you need, OpenClaw, Hermes Agent or a small claw on your own hardware is the better fit.

## Should you self-host?

**Self-host if** you want control over where logs and credentials live, you're comfortable running a server, you need local models for privacy, or you enjoy tinkering.

**Go hosted, or open source and hosted, if** you want an agent that's working tomorrow morning rather than a weekend project, you're running a business rather than a hobby, or you'd rather spend your time on the work the agent does than on the agent itself.

Either way, decide where approvals for irreversible actions live *before* you connect your inbox.
`,
  faq: [
    {
      q: 'What is a self-hosted AI agent?',
      a: 'It is AI agent software, meaning its loop, memory, tools and chat connections, running on a computer you control, such as your laptop, a Mac mini or a VPS. Most self-hosted agents still call a cloud model like Claude or GPT; a fully local setup also runs the model on your own hardware.',
    },
    {
      q: 'What is the best self-hosted AI agent?',
      a: 'For a personal assistant in your chat apps, OpenClaw and Hermes Agent are the most popular, both free and MIT-licensed. For visual workflows, n8n. For a team, Dify or Open WebUI. For a company that wants AI teammates on its own Claude or ChatGPT plan, Brigade is open source and can be self-hosted.',
    },
    {
      q: 'What hardware do I need to self-host an AI agent?',
      a: 'If the agent calls a cloud model, very little: a computer that stays on, or a VPS with 2 vCPUs and 4 GB of RAM. Running the model locally as well needs a GPU or plenty of unified memory, from about $2,000 for capable setups.',
    },
    {
      q: 'Can I use my Claude subscription with a self-hosted agent?',
      a: 'The official Claude Code CLI runs on your own machine or server with your Pro, Max, Ultra or Team plan. Third-party agents like OpenClaw lost subscription coverage for their own Claude sign-in in April 2026 and use extra usage or an API key instead; Anthropic has changed these rules several times, so check its help center.',
    },
    {
      q: 'Are self-hosted AI agents safe?',
      a: 'They can be, but they are servers holding your accounts. In 2026, tens of thousands of OpenClaw instances were found exposed to the internet and hundreds of malicious skills were found on ClawHub. Keep the agent updated and off the public internet, vet every add-on, and put irreversible actions behind an approval step outside the model.',
    },
  ],
  sources: [
    { label: 'OpenClaw on GitHub', url: 'https://github.com/openclaw/openclaw' },
    {
      label: 'Hermes Agent: open-source AI agent',
      url: 'https://hermes-agent.nousresearch.com/open-source-ai-agent',
    },
    { label: 'n8n Sustainable Use License', url: 'https://docs.n8n.io/sustainable-use-license/' },
    { label: 'Dify open source license', url: 'https://docs.dify.ai/policies/open-source' },
    { label: 'Open WebUI license', url: 'https://docs.openwebui.com/license/' },
    { label: 'Claude Code setup and requirements', url: 'https://code.claude.com/docs/en/setup' },
    {
      label: 'Claude Agent SDK overview',
      url: 'https://code.claude.com/docs/en/agent-sdk/overview',
    },
    {
      label: 'InfoWorld: Anthropic cuts OpenClaw access from Claude subscriptions',
      url: 'https://www.infoworld.com/article/4154435/anthropic-cuts-openclaw-access-from-claude-subscriptions-offers-credits-to-ease-transition.html',
    },
    {
      label: 'Hostinger: best OpenClaw hosting',
      url: 'https://www.hostinger.com/tutorials/best-openclaw-hosting/',
    },
    {
      label: 'Hetzner: price adjustment',
      url: 'https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/',
    },
    {
      label: 'TechCrunch: Mac mini shortage',
      url: 'https://techcrunch.com/2026/04/24/mac-mini-price-expensive-ebay-shortage-ai-memory/',
    },
    {
      label: 'The Hacker News: OpenClaw one-click remote code execution',
      url: 'https://thehackernews.com/2026/02/openclaw-bug-enables-one-click-remote.html',
    },
    {
      label: 'The Hacker News: 341 malicious ClawHub skills',
      url: 'https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html',
    },
    {
      label: 'Tom’s Hardware: OpenClaw wipes a Meta director’s inbox',
      url: 'https://www.tomshardware.com/tech-industry/artificial-intelligence/openclaw-wipes-inbox-of-meta-ai-alignment-director-executive-finds-out-the-hard-way-how-spectacularly-efficient-ai-tool-is-at-maintaining-her-inbox',
    },
  ],
}
