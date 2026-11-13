// The comparison pages (app/compare): Brigade beside the tools people weigh it against,
// written for a person choosing and for the AI search engines that answer "X vs Y" and
// "alternative to X". Every line about another product carries its source and the day it
// was checked; every line about Brigade must hold in the code and docs (apps/docs).
// Check the others' facts again before changing CHECKED.

export const CHECKED = 'November 11, 2026'

/** How the other product fares on a row, beside Brigade's check: yes, partly, or no. */
export type Mark = 'yes' | 'partly' | 'no'
/** A row of the side-by-side table. With a mark, Brigade's cell gets a check and theirs the mark. */
export type Row = { label: string; brigade: string; them: string; mark?: Mark }
/** The other product's logo: a file in public/compare, or a harness's mark (components/harness-logo). */
export type Logo = { src: string } | { harness: 'claude_code' | 'codex' }
export type Source = { label: string; url: string }

export type Comparison = {
  slug: string
  /** The other product, as its makers write it. */
  name: string
  /** Its logo (its site's own icon), or one per product when the page compares two. */
  logos: Logo[]
  /** One line for the index and the page's description. */
  oneLiner: string
  /** What the other product is, in its own terms. */
  about: string
  /** The answer, first: how the two differ. */
  answer: string
  rows: Row[]
  pickThem: string[]
  pickBrigade: string[]
  sources: Source[]
  /** The day its sources were checked, when later than CHECKED. */
  checked?: string
}

/** The day a page's facts about the other product were checked. */
export const checkedOn = (x: Comparison) => x.checked ?? CHECKED

/** What Brigade is, the same on every page. */
export const BRIGADE = {
  what: 'An open-source app that gives your company a team of AI teammates, each one the official Claude Code or Codex with a job, its own computer, the Apps you give it and a shared memory.',
  jobs: 'Support, marketing, sales and code, each teammate with one job.',
  ai: 'Claude plans through Claude Code, ChatGPT plans through Codex, signed in with your own accounts. A model per teammate.',
  bill: 'Your own Claude or ChatGPT plan. Brigade never bills you for AI usage.',
  control:
    'For each teammate, you choose whether its writes to Apps (an email through Gmail, a change in Stripe, a merge on GitHub) go on their own or wait for your yes, and each mailbox can be set to approve every email. Every request lands in one Needs you list, also on your phone. Commands and files on its own computer don’t ask.',
  runs: 'Free on your own computer (Mac or Linux). Brigade Cloud gives teammates a computer of their own that keeps working when yours is off.',
  open: 'Yes, MIT. You can read every line and host it yourself.',
  price:
    'Free on your own computer. Cloud: $99 a month per workspace. AI usage is on your own plan.',
}

const row = (label: string, brigade: string, them: string, mark?: Mark): Row => ({
  label,
  brigade,
  them,
  mark,
})

export const COMPARISONS: Comparison[] = [
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    logos: [{ src: '/compare/openclaw.svg' }],
    oneLiner:
      'An open-source personal assistant you install and run yourself, versus a team of teammates with jobs that runs on your Claude or ChatGPT plan.',
    about:
      'OpenClaw is an open-source AI assistant you install and run on your own machine. It works through chat apps such as WhatsApp or Telegram, handles personal tasks (inbox, calendar, errands) and can run one agent per persona.',
    answer:
      'OpenClaw is a powerful personal assistant that you install, run and fix yourself, and that lives in a chat app. Brigade is a team: each teammate has one job, its own Apps and memory, and every decision that needs you lands in one list. Since April 4, 2026, Claude subscription limits no longer cover third-party harnesses like OpenClaw (they draw on paid extra usage instead). Brigade starts the official Claude Code and Codex, signed in with your own accounts.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'An open-source personal AI assistant that you install and run.',
      ),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'A personal assistant: inbox, calendar, errands; one agent per persona.',
      ),
      row(
        'Claude plan',
        'Works: Brigade runs the official Claude Code on your login.',
        'Since April 4, 2026, a Claude subscription no longer covers it: usage is billed as extra usage, or through an API key.',
        'no',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'Chat apps such as WhatsApp, Telegram or Slack.',
      ),
      row(
        'Decisions that need you',
        BRIGADE.control,
        'Inside each chat; no shared list across agents.',
        'no',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared.',
        'Built for one person.',
        'no',
      ),
      row('Open source', BRIGADE.open, 'Yes.', 'yes'),
    ],
    pickThem: [
      'You want one personal assistant inside WhatsApp or Telegram.',
      'You want to run any model, including local ones.',
      'You enjoy installing and tuning your own setup.',
    ],
    pickBrigade: [
      'You want several teammates with clear jobs (support, marketing, sales, code) instead of one assistant.',
      'You want to use the Claude Max or ChatGPT Pro plan you already pay for.',
      'You want an email or a Stripe change to wait for your yes before it happens, from one list on your phone.',
      'Your team needs to see and share the work.',
    ],
    sources: [
      { label: 'openclaw.ai', url: 'https://openclaw.ai' },
      {
        label: 'InfoWorld: Anthropic cuts OpenClaw access from Claude subscriptions',
        url: 'https://www.infoworld.com/article/4154435/anthropic-cuts-openclaw-access-from-claude-subscriptions-offers-credits-to-ease-transition.html',
      },
      {
        label: 'TechRadar: you’ll need to pay to use OpenClaw now',
        url: 'https://www.techradar.com/pro/bad-news-claude-users-anthropic-says-youll-need-to-pay-to-use-openclaw-now',
      },
    ],
  },
  {
    slug: 'grok-bot',
    name: 'Grok Bot',
    logos: [{ src: '/compare/grok-bot.png' }],
    oneLiner:
      'xAI’s AI teammates, locked to Grok models and a Grok subscription, versus teammates that run Claude Code and Codex on the Claude or ChatGPT plan you already pay for.',
    about:
      'Grok Bot is xAI’s product for AI teammates. Each Bot has a job and its own cloud computer, signs in to your tools, works in Slack, Microsoft Teams and video calls, runs routines and can be taught a task by watching it done once. It came out of beta as Grok Bot 1.0 on November 2, 2026, and is sold with Grok’s Premium, Super and Ultra plans.',
    answer:
      'Grok Bot and Brigade share an idea: AI teammates with jobs, a computer of their own and a memory of how your team works. The difference is the AI underneath. Grok Bot is locked to xAI’s Grok models and sold as a Grok subscription. Brigade runs the official Claude Code and Codex, so your teammates work with Anthropic’s and OpenAI’s models, on the Claude or ChatGPT plan you already pay for, they write and ship code, and the whole product is open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'xAI’s AI teammates, each with its own cloud computer, working in Slack, Teams and video calls.',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'xAI’s Grok models only.',
        'no',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'A Grok subscription with weekly usage included; extra usage billed by token.',
        'no',
      ),
      row(
        'Price',
        BRIGADE.price,
        '$30, $100 or $200 a month (Premium, Super, Ultra); Teams and Enterprise through sales.',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Through GitHub and by coordinating coding agents; not its focus.',
        'partly',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'Its desktop and iOS apps, Slack, Microsoft Teams, and Google Meet, Zoom or Teams calls.',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You already pay for Grok and want your AI teammates inside Slack, Teams and your calls.',
    ],
    pickBrigade: [
      'You want Claude and GPT, not just Grok, with the model you choose for each teammate.',
      'You already pay for Claude Max or ChatGPT Pro and do not want another AI subscription.',
      'You want teammates that write, test and ship your code, with previews to try it.',
      'You want to read the code, or host it yourself.',
    ],
    sources: [
      { label: 'x.ai/bot', url: 'https://x.ai/bot' },
      { label: 'xAI: Introducing Grok Bot 1.0', url: 'https://x.ai/news/grok-bot-1-0' },
    ],
  },
  {
    slug: 'rakazo',
    name: 'Rakazo',
    logos: [{ src: '/compare/rakazo.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'Open-source bots on their own agent loop, with Claude through an API key and hosted plans metered in computer hours, versus teammates that are the official Claude Code and Codex on the plans you already pay for.',
    about:
      'Rakazo is an open-source (Apache-2.0) platform for AI bots that each take on a job, such as sorting email or researching sales prospects, with a computer, Apps, memory, routines and approvals. You reach them from its web, desktop, iOS and Android apps or from chat apps. Its bots run on Rakazo’s own agent loop (Pi) with the model you connect. You can host it yourself, or use Rakazo Cloud (in beta), whose plans cost $15, $49 or $99 a month with 25, 100 or 200 computer hours.',
    answer:
      'Rakazo and Brigade share an idea: open-source AI teammates with jobs, a computer and memory. The difference is what does the work. Rakazo runs its own agent loop on the server, with models paid through API keys or a ChatGPT plan; its own docs say Anthropic’s rules don’t let it use a Claude subscription, so Claude means paying per token. Brigade starts the official Claude Code and Codex, signed in with your own Claude or ChatGPT plan, so the Claude Max you already pay for does the work. And Brigade Cloud is one flat price for an always-on computer, where Rakazo’s hosted plans stop work on the computer once the month’s hours are used up.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'An open-source platform for AI bots that each take on a job, with a computer, Apps and memory.',
      ),
      row(
        'The agent doing the work',
        'The official Claude Code and Codex, built by Anthropic and OpenAI, on your own logins.',
        'Rakazo’s own agent loop (Pi), running on the Rakazo server, with the model you connect.',
      ),
      row(
        'Claude plan',
        'Works: Brigade runs the official Claude Code on your login.',
        'Not covered: its docs ask for an Anthropic API key and advise against the Claude sign-in it offers, which Anthropic’s rules forbid.',
        'no',
      ),
      row(
        'ChatGPT plan',
        'Works: Brigade runs the official Codex on your login.',
        'Works, through ChatGPT sign-in.',
        'yes',
      ),
      row(
        'Price',
        BRIGADE.price,
        'Free to host yourself. Rakazo Cloud (in beta): $15, $49 or $99 a month for 25, 100 or 200 computer hours, or a credits plan from $10 a month.',
      ),
      row(
        'Computer time',
        'Brigade Cloud’s computer stays on all month, with no allowance of hours.',
        'Counted in hours; once a month’s hours are used up, work that needs the computer stops until you upgrade or the plan renews.',
        'partly',
      ),
      row(
        'Code',
        'Each teammate is Claude Code or Codex: it writes, tests and ships code, with pull requests and previews.',
        'A coding bot template; repository tasks can be handed to T3 Code or, when self-hosted, to Cursor’s cloud agents.',
        'partly',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'Web, desktop, iOS and Android apps, and chat apps such as Slack; WhatsApp, Telegram and iMessage only when you host it yourself.',
      ),
      row('Open source', BRIGADE.open, 'Yes, Apache-2.0.', 'yes'),
    ],
    pickThem: [
      'You want to choose any model, including local ones, and pay for it through API keys.',
      'You want your bots in WhatsApp, Telegram or iMessage, and you are ready to host it yourself.',
    ],
    pickBrigade: [
      'You pay for Claude Max or Pro and want your teammates to work on it, through the official Claude Code.',
      'You want teammates that are the coding agents Anthropic and OpenAI build, not a separate agent loop.',
      'You want one flat price for a computer that stays on, not a monthly allowance of hours.',
      'You want every decision that needs you in one Needs you list, shared with your team.',
    ],
    sources: [
      { label: 'rakazo.com', url: 'https://rakazo.com' },
      { label: 'Rakazo pricing', url: 'https://rakazo.com/pricing/' },
      {
        label: 'Rakazo: self-host only, for now',
        url: 'https://rakazo.com/self-hosted-ai-agent/#self-host-only',
      },
      { label: 'Rakazo on GitHub', url: 'https://github.com/elie222/rakazo' },
      {
        label: 'Rakazo docs: model subscriptions',
        url: 'https://github.com/elie222/rakazo/blob/main/docs/model-subscriptions.md',
      },
      {
        label: 'Rakazo docs: computer runtime',
        url: 'https://github.com/elie222/rakazo/blob/main/docs/computer-runtime.md',
      },
      {
        label: 'Rakazo docs: cloud coding agents',
        url: 'https://github.com/elie222/rakazo/blob/main/docs/self-host-integrations.md#cloud-coding-agents',
      },
    ],
  },
  {
    slug: 'hermes-agent',
    name: 'Hermes Agent',
    logos: [{ src: '/compare/hermes-agent.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'An open-source personal agent you install and run, which a Claude plan covers only through extra usage, versus a team that runs the official Claude Code and Codex on the plans you already pay for.',
    about:
      'Hermes Agent is Nous Research’s open-source (MIT) agent, “the agent that grows with you”: it writes skills from experience, keeps a memory of you across sessions, runs scheduled jobs, and talks to you from Telegram, Discord, Slack, WhatsApp, Signal or email while it works on your machine, a server or a cloud sandbox. It works with any model, from Nous Portal and OpenRouter to local ones, and Nous sells hosted plans from $20 a month.',
    answer:
      'Hermes Agent is a strong personal agent that you install, configure and run yourself: one agent, one memory. Brigade is a team: each teammate has one job, its own Apps and memory, every decision that needs you lands in one list, and your team works in the same threads. The AI bill differs too: Hermes’s own docs say a Claude Max login draws only on purchased extra usage, and Claude Pro can’t be used at all. Brigade starts the official Claude Code and Codex, signed in with your own accounts, so your plan’s included usage does the work.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'An open-source personal agent that learns skills from experience, which you install and run.',
      ),
      row(
        'Claude plan',
        'Works: Brigade runs the official Claude Code on your login.',
        'Max only through purchased extra usage, never the plan’s included usage; Pro can’t be used, so an API key instead.',
        'no',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'Any model: Nous Portal, OpenRouter, OpenAI, Anthropic, local models and more.',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Approval for risky shell commands (by default a second model rates the risk), asked in the chat or terminal.',
        'partly',
      ),
      row(
        'Code',
        'Each teammate is Claude Code or Codex: it writes, tests and ships code, with pull requests and previews.',
        'Terminal and file tools, and skills that hand coding to Claude Code, Codex or OpenCode.',
        'partly',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'Its terminal, a desktop app, and chat apps such as Telegram, Slack and WhatsApp.',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared.',
        'One agent, one memory; Hermes Business (price on request) shares a hosted deployment across a team.',
        'partly',
      ),
      row('Open source', BRIGADE.open, 'Yes, MIT.', 'yes'),
    ],
    pickThem: [
      'You want one personal agent inside Telegram, Slack or WhatsApp.',
      'You want to run any model, including local ones.',
      'You enjoy installing and tuning your own setup.',
    ],
    pickBrigade: [
      'You want several teammates with clear jobs (support, marketing, sales, code) instead of one agent.',
      'You want the Claude Pro or Max plan you already pay for to do the work, without extra usage.',
      'You want an email or a Stripe change to wait for your yes, from one list on your phone.',
      'Your team needs to see and share the work.',
    ],
    sources: [
      { label: 'hermes-agent.nousresearch.com', url: 'https://hermes-agent.nousresearch.com/' },
      { label: 'Hermes Agent on GitHub', url: 'https://github.com/NousResearch/hermes-agent' },
      {
        label: 'Hermes Agent docs: providers and subscriptions',
        url: 'https://hermes-agent.nousresearch.com/docs/integrations/providers',
      },
      {
        label: 'Hermes Agent docs: security and approvals',
        url: 'https://hermes-agent.nousresearch.com/docs/user-guide/security',
      },
      { label: 'Nous Portal', url: 'https://portal.nousresearch.com/' },
      { label: 'Hermes Business', url: 'https://portal.nousresearch.com/business' },
    ],
  },
  {
    slug: 'claude-duet',
    name: 'Claude Duet',
    logos: [{ src: '/compare/claude-duet.svg' }],
    checked: 'November 13, 2026',
    oneLiner:
      'Anthropic’s proactive agent for one person, in a US waitlist preview, versus a team of AI teammates for your company that runs on your Claude or ChatGPT plan today.',
    about:
      'Claude Duet is an Anthropic app, released as a research preview on October 21, 2026, where Claude works as a proactive agent: it brings you what needs your attention, does tasks on its own cloud computer, sends a morning brief, and asks before it sends messages, pays, signs or deletes anything. It runs on Claude Opus 5.5, is included in Claude’s Pro, Max and Ultra plans, and opened by waitlist to US subscribers, on iOS, Android and claude.ai.',
    answer:
      'Claude Duet is one proactive agent for one person. Brigade gives your whole company a team: several teammates at once, each with its own job, Apps and memory, your colleagues in the same threads, and every decision in one shared list. Brigade runs Claude through the official Claude Code and GPT through Codex, so you pick a model per teammate; its teammates write, test and ship code with pull requests; and anyone can start today, not only by waitlist in the US.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A proactive agent for one person, in one ongoing conversation, with its own cloud computer.',
      ),
      row(
        'Availability',
        'Open to everyone: sign up and start today.',
        'A research preview by waitlist, starting with US Pro, Max and Ultra subscribers.',
        'no',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'Claude Opus 5.5 only; you can’t choose a model.',
        'partly',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Included in your Claude plan, sharing its usage limits.',
        'yes',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared, and each teammate holds one job.',
        'Built for one person; Claude’s Team and Enterprise plans aren’t included yet.',
        'no',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Asks before it sends messages, pays, signs or deletes anything, in its own app.',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Builds prototypes, dashboards and web apps; no code workflow described.',
        'partly',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You are in the US on a Claude plan and want one proactive assistant for your own work.',
    ],
    pickBrigade: [
      'You want a team for your company: several teammates, each with its own job, and your colleagues in the same threads.',
      'You want ChatGPT as well as Claude, with a model per teammate.',
      'You want code written, tested and shipped through pull requests.',
      'You want to start today, wherever you are, and read the code.',
    ],
    sources: [
      { label: 'Claude Duet', url: 'https://claude.com/product/claude-duet' },
      {
        label: 'Anthropic: Introducing Claude Duet',
        url: 'https://claude.com/resources/articles/claude-duet',
      },
      {
        label: 'Claude Help Center: Claude Duet',
        url: 'https://support.claude.com/en/articles/17631495',
      },
      {
        label: 'Anthropic: Claude Duet safety, privacy and security',
        url: 'https://claude.com/resources/articles/claude-duet-safety-privacy-and-security',
      },
    ],
  },
  {
    slug: 'muse',
    name: 'Meta Muse',
    logos: [{ src: '/compare/muse.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'Meta’s personal AI agent on its own model and plans, versus a team of AI teammates for your company on the Claude or ChatGPT plan you already pay for.',
    about:
      'Muse is Meta’s personal AI agent, launched on September 8, 2026 as “AI that gets it done for you”. It works on a persistent cloud computer with a browser, remembers across conversations, follows up on a schedule, checks with you before important actions such as sending an email or making a purchase, and connects to apps such as email, calendar, Instagram, Shopify, Slack and Stripe. It runs on Meta’s Muse Spark model, in its iOS, Android, web and Mac apps and in WhatsApp, free with a usage limit or at $20 or $100 a month.',
    answer:
      'Muse is one personal agent per person, built on Meta’s own model and sold as Meta’s own plans. Brigade gives your company a team: several teammates at once, each with its own job, Apps and memory, your colleagues in the same threads, and every decision in one shared list. Brigade runs the official Claude Code and Codex on the Claude or ChatGPT plan you already pay for, its teammates write and ship your code, and it is open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A personal AI agent for your life, with a cloud computer of its own.',
      ),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'One person’s tasks, from email and shopping to running a small business.',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'Meta’s Muse Spark only.',
        'partly',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Meta’s own plans: free with a usage limit, or $20 or $100 a month for more Muse tokens a week.',
        'no',
      ),
      row(
        'Availability',
        'Sign up and start today, in Europe too.',
        'In limited testing, in a few countries such as the US, Canada and Singapore.',
        'partly',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared, and each teammate holds one job.',
        'One Muse per person; Muse for Small Business adds tools for a single owner.',
        'no',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Asks before important actions such as sending an email or making a purchase.',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Writes code to build its own tools and dashboards; not made to ship yours.',
        'partly',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'Its iOS, Android, web and Mac apps, and WhatsApp.',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: ['You want a personal agent for your own life, inside WhatsApp, with a free plan.'],
    pickBrigade: [
      'You want a team for your company (support, marketing, sales, code), with your colleagues in the same threads.',
      'You already pay for Claude Max or ChatGPT Pro and do not want another AI plan.',
      'You want your code written, tested and shipped through pull requests.',
      'You want to read the code, or host it yourself.',
    ],
    sources: [
      { label: 'muse.ai', url: 'https://muse.ai' },
      {
        label: 'Meta: Introducing Muse',
        url: 'https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/',
      },
      {
        label: 'Meta: Muse for Small Business',
        url: 'https://about.fb.com/news/2026/09/introducing-muse-small-business/',
      },
      { label: 'Muse for business', url: 'https://muse.ai/business' },
      {
        label: 'Meta Help Center: About Muse subscriptions',
        url: 'https://www.meta.com/help/subscriptions/1021145227643680/',
      },
      {
        label: 'Meta: Muse is now available in Singapore',
        url: 'https://about.fb.com/news/2026/10/muse-is-now-available-in-singapore/',
      },
    ],
  },
  {
    slug: 'dots',
    name: 'OpenAI dots',
    logos: [{ src: '/compare/dots.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'One always-on agent per person inside ChatGPT, on Pro and business plans, versus a team of AI teammates on Claude and ChatGPT side by side, open source and free on your own computer.',
    about:
      'dots are OpenAI’s always-on agents inside ChatGPT, announced on September 29, 2026. Each dot has its own cloud computer and browser, learns from feedback, runs scheduled checks, can build and test fixes and bring back pull requests, and works in ChatGPT, Slack and Teams. Each member gets one personal dot with ChatGPT Pro (rolling out outside the EEA, Switzerland and the UK) or Business Premium, and with Enterprise and Edu plans. It runs on OpenAI’s GPT-6 models.',
    answer:
      'A dot is one always-on agent per person, inside ChatGPT. Brigade gives your company a team: several teammates at once, each with its own job, Apps and memory, your colleagues in the same threads, and every decision in one shared list. Brigade runs Codex on your ChatGPT plan and Claude Code on your Claude plan, side by side, so you pick a model per teammate. It is free on your own computer, and open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'An always-on agent inside ChatGPT, one per person, with its own cloud computer.',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'OpenAI’s GPT-6 models only.',
        'partly',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Included in ChatGPT Pro and Business Premium; Enterprise and Edu are billed for it from November 18, 2026.',
        'partly',
      ),
      row(
        'Availability',
        'Sign up and start today, in Europe too.',
        'On Pro, rolling out outside the EEA, Switzerland and the UK.',
        'partly',
      ),
      row(
        'Your team',
        'Several teammates with their own jobs, and your colleagues in the same threads, lists and files.',
        'One personal dot per member; specialist dots for organizations are in enterprise pilots.',
        'partly',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Yes: it builds and tests fixes, brings back pull requests and can start Codex tasks.',
        'yes',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Rules for when it acts alone, asks first or hands off to you; purchases need approval.',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'ChatGPT on desktop, web and mobile, Slack and Teams.',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You pay for ChatGPT Pro where dots are offered, and want one always-on agent inside ChatGPT, Slack and Teams.',
    ],
    pickBrigade: [
      'You want a team for your company, several teammates each with its own job, not one agent per person.',
      'You want Claude as well as GPT, with a model per teammate.',
      'You want to start free on your own computer, or you are in the EU or the UK on a personal plan.',
      'You want to read the code, or host it yourself.',
    ],
    sources: [
      { label: 'OpenAI: Introducing dots', url: 'https://openai.com/index/introducing-dots/' },
      {
        label: 'OpenAI Help Center: Getting started with your dot',
        url: 'https://help.openai.com/en/articles/20001530-getting-started-with-your-dot',
      },
      {
        label: 'OpenAI Help Center: dots privacy, security and safety',
        url: 'https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs',
      },
      { label: 'ChatGPT pricing', url: 'https://chatgpt.com/pricing' },
      {
        label: 'MacRumors: OpenAI launches dots',
        url: 'https://www.macrumors.com/2026/09/29/openai-launches-dots/',
      },
    ],
  },
  {
    slug: 'instinct',
    name: 'Instinct',
    logos: [{ src: '/compare/instinct.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'An invite-only personal assistant you text or call, versus a team of AI teammates for your company that you can start today on the Claude or ChatGPT plan you already pay for.',
    about:
      'Instinct, from Spear Street Technology, describes itself as “a personal assistant that understands what you’re working on and what’s important to you”. You text or call it, and it uses a phone and a computer to run errands such as ordering groceries or booking a train. When we checked, access was reported as invite-only, its terms mentioned a waitlist, and it published no prices.',
    answer:
      'Instinct is a personal assistant for one person’s errands, reached by text or phone. Brigade is a team for your company: support, marketing, sales and code, each teammate with its own job, Apps and memory, and your team in the same threads. Brigade runs the official Claude Code and Codex on your own Claude or ChatGPT plan, the App actions you choose wait for your yes, and you can sign up today and read every line of its code.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A personal assistant you text or call, which uses a phone and a computer for you.',
      ),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'One person’s tasks and errands, such as groceries or a train booking.',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared.',
        'Built for one person.',
        'no',
      ),
      row('Who pays for AI', BRIGADE.bill, 'Included in the service; its models are not named.'),
      row('Price', BRIGADE.price, 'Not published; its terms say some features require payment.'),
      row(
        'Open to sign up',
        'Yes: sign up and start today, free on your own computer.',
        'Reported as invite-only; its terms mention a waitlist.',
        'no',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Not what it is for.',
        'no',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You want one personal assistant for your errands, reached by text or a phone call.',
    ],
    pickBrigade: [
      'You want teammates for your company’s work (support, marketing, sales, code), not one personal assistant.',
      'You want to start today, without waiting for an invite.',
      'You already pay for Claude Max or ChatGPT Pro and want your teammates to use it.',
      'You want to read the code that holds your logins and your customers’ email.',
    ],
    sources: [
      { label: 'instinct.com', url: 'https://instinct.com/' },
      { label: 'Instinct terms of service', url: 'https://instinct.com/terms' },
      {
        label: 'TechCrunch: Instinct’s AI assistant raises privacy and security concerns',
        url: 'https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/',
      },
      {
        label: 'Skift: a viral AI bot and travel',
        url: 'https://skift.com/2026/09/04/a-viral-ai-bot-just-showed-travel-what-frictionless-actually-means/',
      },
    ],
  },
  {
    slug: 'hark',
    name: 'Hark',
    logos: [{ src: '/compare/hark.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'A personal AI for one person’s life, on its own usage plans, versus a team of AI teammates for your company on the Claude or ChatGPT plan you already pay for.',
    about:
      'Hark Pro, from Hark Labs, launched on October 6, 2026 as a personal AI that runs your life from one conversation: email, errands, food orders, scheduled tasks and reminders, with memory and Apps such as Google, Outlook and Spotify. Its Handoff agent (a research preview) works on a virtual computer of its own. It runs on Hark’s own models and third-party ones, on the web, iOS and Android, free or at $20 or $100 a month for more usage.',
    answer:
      'Hark is a personal AI for one person’s life. Brigade is a team for your company: support, marketing, sales and code, each teammate with its own job, Apps and memory, and your team in the same threads. Brigade runs the official Claude Code and Codex on the Claude or ChatGPT plan you already pay for instead of another usage plan, its teammates write and ship code, and it is open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A personal AI for your life, in one conversation, with a virtual computer of its own.',
      ),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'One person’s tasks: email, errands, food orders, reminders, docs and slides.',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'Hark’s own models first, and third-party models it does not name.',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Hark’s own plans: free, or $20 or $100 a month for 2× or 10× the usage.',
        'no',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Builds websites and slides; not made to ship code.',
        'partly',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared.',
        'Built for one person; no team plan.',
        'no',
      ),
      row(
        'Where you talk to it',
        'Brigade’s own app (web, or installed on your phone with push notifications), and with Cloud an email address per teammate.',
        'Its web, iOS and Android apps.',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: ['You want a personal assistant for your own life, on your phone, with a free plan.'],
    pickBrigade: [
      'You want teammates for your company’s work (support, marketing, sales, code), not a personal assistant.',
      'You already pay for Claude Max or ChatGPT Pro and do not want another AI plan.',
      'You want code written, tested and shipped too.',
      'You want to read the code, or host it yourself.',
    ],
    sources: [
      { label: 'hark.com', url: 'https://hark.com/' },
      { label: 'Hark pricing', url: 'https://hark.com/pricing' },
      {
        label: 'Hark: Introducing Hark Pro',
        url: 'https://hark.com/articles/introducing-hark-pro',
      },
      {
        label: 'Hark: Introducing Hark Handoff',
        url: 'https://hark.com/articles/introducing-hark-handoff',
      },
      { label: 'Hark security', url: 'https://hark.com/security' },
      {
        label: 'TechCrunch: Hark releases an AI personal assistant',
        url: 'https://techcrunch.com/2026/10/06/hark-releases-an-ai-personal-assistant-with-a-focus-on-privacy/',
      },
    ],
  },
  {
    slug: 'claude-cowork',
    name: 'Claude Cowork',
    logos: [{ src: '/compare/claude-cowork.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'Claude working across one person’s files and tools, versus a team of AI teammates with jobs and one shared list of decisions, on Claude and ChatGPT side by side.',
    about:
      'Claude Cowork is Anthropic’s agent for work beyond code, launched in January 2026 as “Claude Code for the rest of your work”. Since September 2026 it is part of the Claude app itself (“Claude Cowork is now just Claude”): Claude works across your files and tools toward a goal, in cloud sessions that carry on after you close your laptop, runs scheduled tasks, and asks before acting by default. It comes with Claude’s paid plans (Pro, Max, Ultra, Team and Enterprise) and draws on their usage limits.',
    answer:
      'Cowork made Claude an agent for everyday work, for one person and their own tasks. Brigade makes Claude Code and Codex a team for your company: several teammates at once, each with its own job, Apps, memory and rules, triggers that start them on their own, your colleagues in the same threads, and every decision that needs you in one shared list. It runs on the same Claude plan, adds your ChatGPT plan beside it, and is open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'Claude as an agent across your files and tools, now part of the Claude app.',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Included in Claude’s paid plans; it uses their limits faster than chat.',
        'yes',
      ),
      row(
        'AI models',
        'Claude through Claude Code and GPT through Codex, side by side; a model per teammate.',
        'Claude only.',
        'partly',
      ),
      row(
        'Your team',
        'Several teammates, each with one job, and your colleagues in the same threads, lists and files.',
        'One person’s sessions; on Team and Enterprise, admins manage access and connectors, and finished work can be shared.',
        'partly',
      ),
      row(
        'Starts on its own',
        'Yes: triggers (an email, a webhook, a failed payment) and schedules.',
        'Scheduled tasks, such as a weekly report.',
        'partly',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Asks before acting by default, inside each session; you can let it carry on and check in when needed.',
        'partly',
      ),
      row(
        'Code',
        'Each teammate is Claude Code or Codex: it writes, tests and ships code, with pull requests and previews.',
        'Runs code in its sandbox to make files; Claude Code is Anthropic’s separate product for software.',
        'partly',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: ['You work alone and want Claude to handle your own documents, research and files.'],
    pickBrigade: [
      'You want a team for your company, several teammates with their own jobs, not one assistant per person.',
      'You want ChatGPT beside Claude, with a model per teammate.',
      'You want teammates to start on their own when an email, a webhook or a failed payment arrives.',
      'You want your colleagues and every decision in one place, and to read the code.',
    ],
    sources: [
      { label: 'Claude Cowork', url: 'https://claude.com/product/cowork' },
      {
        label: 'Anthropic: Cowork is now Claude',
        url: 'https://claude.com/blog/cowork-is-now-claude',
      },
      {
        label: 'Claude Help Center: Get started with Claude Cowork',
        url: 'https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork',
      },
      {
        label: 'Claude Help Center: Use Claude Cowork safely',
        url: 'https://support.claude.com/en/articles/13364135-use-claude-cowork-safely',
      },
      { label: 'Claude pricing', url: 'https://claude.com/pricing' },
      {
        label: 'Simon Willison: first impressions of Claude Cowork',
        url: 'https://simonwillison.net/2026/Jan/12/claude-cowork/',
      },
    ],
  },
  {
    slug: 'manus',
    name: 'Manus',
    logos: [{ src: '/compare/manus.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'A general AI agent billed in Manus credits, versus a team of AI teammates that run on the Claude or ChatGPT plan you already pay for and keep you in the decisions.',
    about:
      'Manus is an AI agent from Butterfly Effect, a Singapore company. You give it a goal and it works in its own cloud computer to deliver research, slides, websites and apps, with scheduled tasks, automations and a team plan with shared projects. It picks the model for each step and bills in Manus credits: free with 300 credits a day, Pro at $20 a month (4,000 credits), Max at $200 a month (40,000 credits), and Team at $20 a seat.',
    answer:
      'Manus is a capable general agent: you hand it a goal and it delivers, paid in credits on top of any AI plan you already have. Brigade gives your company a team: each teammate has one job, its own Apps, memory and rules, and the App actions you choose wait for your yes in one Needs you list. It runs the official Claude Code and Codex on the Claude or ChatGPT plan you already pay for, so there is no credit meter, and it is open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A general AI agent that turns a goal into finished work in its own cloud computer.',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Manus credits; with Flex you can bring an API key for the model, but its computer and other tools still use credits.',
        'no',
      ),
      row(
        'Price',
        BRIGADE.price,
        'Free (300 credits a day), Pro $20 a month (4,000 credits), Max $200 a month (40,000 credits); Team $20 a seat a month.',
      ),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'Research, slides, websites, apps and other deliverables from a goal.',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Works with few permission limits in its own sandbox; on your computer, only in the files and apps you approved.',
        'partly',
      ),
      row(
        'Starts on its own',
        'Yes: triggers (an email, a webhook, a failed payment) and schedules.',
        'Scheduled tasks, and automations that start when something happens in a connected service.',
        'yes',
      ),
      row(
        'Your team',
        'Invite your team: threads, lists and files are shared.',
        'A Team plan with shared projects, skills and pooled credits.',
        'yes',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You want one agent that turns a goal into research, slides or a website, and paying in credits suits you.',
    ],
    pickBrigade: [
      'You already pay for Claude Max or ChatGPT Pro and do not want a credit meter on top.',
      'You want teammates with clear jobs (support, marketing, sales, code) and their own rules.',
      'You want an email or a Stripe change to wait for your yes, from one list on your phone.',
      'You want to read the code, or host it yourself.',
    ],
    sources: [
      { label: 'manus.im', url: 'https://manus.im/' },
      { label: 'Manus pricing', url: 'https://manus.im/pricing' },
      { label: 'Manus for teams', url: 'https://manus.im/team' },
      { label: 'Manus docs: Flex', url: 'https://manus.im/docs/models/manus-flex' },
      { label: 'Manus: the sandbox', url: 'https://www.manus.im/blog/manus-sandbox' },
      { label: 'Manus: Introducing Manus 2.0', url: 'https://manus.im/blog/introducing-manus-2-0' },
    ],
  },
  {
    slug: 'relevance-ai',
    name: 'Relevance AI',
    logos: [{ src: '/compare/relevance-ai.png' }],
    checked: 'November 13, 2026',
    oneLiner:
      'An enterprise platform for an “AI Workforce”, sold through sales and metered in actions and credits, versus open-source teammates you can start today on the Claude or ChatGPT plan you already pay for.',
    about:
      'Relevance AI, based in San Francisco and Sydney, calls itself “the home of the AI Workforce”: a hosted platform where companies build agents for sales, support and operations, with tools, triggers (a schedule, a new email, a Slack message, a webhook), human approvals and over 2,000 integrations. Its pricing page lists one Enterprise plan, through sales; usage is metered in Actions and Vendor Credits, with models such as Claude, GPT and Gemini, or your own API key.',
    answer:
      'Relevance AI is built for enterprises that run an AI workforce with a vendor’s team behind it, metered per action and per model credit. Brigade gives any company a team you can start today: each teammate is the official Claude Code or Codex with a job, its own computer, Apps and memory. It runs on the Claude or ChatGPT plan you already pay for, writes and ships code too, and is open source and free on your own computer.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A hosted platform for building AI agents and workforces for enterprise teams.',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Relevance AI’s Actions and Vendor Credits, or your own API key for the model.',
        'no',
      ),
      row('Price', BRIGADE.price, 'An Enterprise plan through sales; no public prices.'),
      row(
        'Getting started',
        'Sign up and start today, free on your own computer.',
        'Talk to sales.',
        'partly',
      ),
      row(
        'Code',
        'Each teammate is Claude Code or Codex: it writes, tests and ships code, with pull requests and previews.',
        'Python steps in its tool builder; not a coding agent.',
        'partly',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'Human-in-the-loop approvals, with agents set anywhere from assisted to fully autonomous.',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You are a large company that wants an AI workforce built with a vendor’s team, under a sales contract.',
    ],
    pickBrigade: [
      'You want to start today, without a sales call.',
      'You already pay for Claude or ChatGPT and want that plan to do the work.',
      'You want the same team to write and ship code as well.',
      'You want to read the code, or host it yourself.',
    ],
    sources: [
      { label: 'relevanceai.com', url: 'https://relevanceai.com/' },
      { label: 'Relevance AI pricing', url: 'https://relevanceai.com/pricing' },
      {
        label: 'Relevance AI docs: plans',
        url: 'https://relevanceai.com/docs/get-started/subscriptions/plans',
      },
      {
        label: 'Relevance AI docs: triggers',
        url: 'https://relevanceai.com/docs/build/agents/build-your-agent/triggers',
      },
      {
        label: 'TechCrunch: Relevance AI raises $24M Series B',
        url: 'https://techcrunch.com/2025/05/06/relevance-ai-raises-24m-series-b-to-help-anyone-build-teams-of-ai-agents/',
      },
    ],
  },
  {
    slug: 'paperclip',
    name: 'Paperclip',
    logos: [{ src: '/compare/paperclip.svg' }],
    oneLiner:
      'An open-source framework that organizes agents into a company you govern as a board, versus hosted teammates whose App actions can wait for your yes.',
    about:
      'Paperclip is an open-source (MIT), self-hosted platform that organizes AI agents such as Claude Code, Codex or OpenClaw into a company, with an org chart, goals, budgets, tickets and governance. You start it yourself (it runs with npx); a hosted version was on a waitlist when we checked.',
    answer:
      'Paperclip and Brigade share an idea: a company of agents, open source. Paperclip has you govern like a board (hires, budgets, pausing agents) on a server you run. Brigade is hosted or self-hosted, you can approve the actions themselves (the email before it goes, the change in Stripe), and your team works in the same threads.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'An open-source framework that structures agents into a company, with an org chart, budgets and governance.',
      ),
      row(
        'Agents it runs',
        'The official Claude Code and Codex.',
        'Bring your own: Claude Code, Codex, OpenClaw, Cursor and others through adapters.',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'As a board: approve hires, set per-agent budgets, pause agents, read the audit log.',
        'partly',
      ),
      row(
        'Where it runs',
        BRIGADE.runs,
        'Self-hosted; a hosted cloud was on a waitlist.',
        'partly',
      ),
      row(
        'Apps',
        'Built-in Apps (Gmail, GitHub, Stripe, Notion, Linear and more), any MCP server, and webhooks.',
        'Through the agents you plug in.',
        'partly',
      ),
      row('Open source', BRIGADE.open, 'Yes, MIT.', 'yes'),
    ],
    pickThem: [
      'You want to plug in many agent runtimes, not only Claude Code and Codex.',
      'You want to run it on your own server and manage agents by budget and org chart.',
    ],
    pickBrigade: [
      'You want it ready to use: hosted, on your phone, with your team.',
      'You want to approve an email or a payment change before it happens, rather than set budgets.',
      'You want built-in Apps, a computer per teammate and memory without assembling them.',
    ],
    sources: [
      { label: 'paperclip.ing', url: 'https://paperclip.ing/product/' },
      { label: 'Paperclip open source', url: 'https://paperclip.ing/product/open-source/' },
      {
        label: 'Fast.io: Paperclip AI review 2026',
        url: 'https://fast.io/resources/paperclip-ai-review-2026/',
      },
    ],
  },
  {
    slug: 'lindy',
    name: 'Lindy',
    logos: [{ src: '/compare/lindy.png' }],
    oneLiner:
      'A hosted agent platform billed in credits, versus open-source teammates that run on the Claude or ChatGPT plan you already pay for.',
    about:
      'Lindy is a hosted platform for building AI agents and assistants for business workflows such as email, meetings, sales and support. Its paid plans are billed per user and metered in credits.',
    answer:
      'Lindy is polished and hosted, but every task spends its credits, on top of any AI plan you already have, and its code is closed. Brigade runs the official Claude Code and Codex on your own Claude or ChatGPT plan, so there is no second AI bill, the same teammates also write and ship code, and the whole product is open source.',
    rows: [
      row(
        'What it is',
        BRIGADE.what,
        'A hosted platform for AI agents and assistants for business workflows.',
      ),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'Email, meetings, sales, support and other business workflows.',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Lindy’s own credits, included in each plan, with top-ups.',
        'no',
      ),
      row(
        'Price',
        BRIGADE.price,
        'Paid plans reported from about $30 per user per month (3,000 credits) up to about $200; check lindy.ai/pricing.',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'Not its focus.',
        'no',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: [
      'You want a no-setup hosted assistant and do not use Claude or ChatGPT plans.',
      'Your work is mainly meetings and email, with no code.',
    ],
    pickBrigade: [
      'You already pay for Claude Max or ChatGPT Pro and do not want a second AI bill.',
      'You want the same team to handle code as well as support, marketing and sales.',
      'You want to read the code that holds your passwords and your customers’ email.',
    ],
    sources: [
      { label: 'lindy.ai/pricing', url: 'https://www.lindy.ai/pricing' },
      { label: 'Zapier: Lindy pricing', url: 'https://zapier.com/blog/lindy-pricing/' },
      { label: 'Dupple: Lindy AI pricing 2026', url: 'https://dupple.com/learn/lindy-ai-pricing' },
    ],
  },
  {
    slug: 'sintra',
    name: 'Sintra',
    logos: [{ src: '/compare/sintra.png' }],
    oneLiner:
      'A bundle of preset AI helpers on monthly credits, versus teammates you shape, that use your own Claude or ChatGPT plan and can wait for your yes.',
    about:
      'Sintra sells a bundle of preset "AI employees" (helpers for marketing, social media, support, sales and more) on a monthly plan with a monthly credit allowance.',
    answer:
      'Sintra gives you ready-made helpers with fixed roles and a monthly credit allowance. In Brigade you give each teammate the job, Apps and rules you want, it works on your own Claude or ChatGPT plan, it can also write code, and the App actions you choose wait for your yes. Brigade is open source.',
    rows: [
      row('What it is', BRIGADE.what, 'A bundle of preset AI helpers with fixed roles.'),
      row(
        'Jobs it covers',
        BRIGADE.jobs,
        'Marketing, social media, support, sales and other preset roles.',
      ),
      row(
        'Who pays for AI',
        BRIGADE.bill,
        'Sintra’s own credits: a monthly allowance (250 reported) that does not roll over.',
        'no',
      ),
      row(
        'Price',
        BRIGADE.price,
        'Reported from about $39 to $97 a month, with promotional annual prices; check sintra.ai.',
      ),
      row(
        'Code',
        'Teammates write, test and ship code, with pull requests and previews.',
        'No.',
        'no',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: ['You want preset helpers for social media and marketing, with nothing to set up.'],
    pickBrigade: [
      'You want teammates shaped to your company, with your own Apps, rules and memory.',
      'You want your Claude or ChatGPT plan to do the work instead of a second bill.',
      'You also need code written and shipped.',
    ],
    sources: [
      { label: 'sintra.ai', url: 'https://sintra.ai' },
      {
        label: 'eesel: Sintra AI pricing 2026',
        url: 'https://www.eesel.ai/blog/sintra-ai-pricing',
      },
      {
        label: 'Toolradar: Sintra AI pricing',
        url: 'https://toolradar.com/tools/sintra-ai/pricing',
      },
    ],
  },
  {
    slug: 'polsia',
    name: 'Polsia',
    logos: [{ src: '/compare/polsia.png' }],
    oneLiner:
      'An autonomous platform that runs a company overnight for a share of revenue, versus teammates that work with you and keep you in the decisions.',
    about:
      'Polsia is a hosted platform whose agents plan, build, market and operate a business on their own, on a nightly cycle with a report in the morning. It is most often reported at $49 a month plus 20% of the revenue it brings, though its pricing changed several times in 2026.',
    answer:
      'Polsia runs on its own and reports in the morning; you pay it a share of revenue on top of a subscription. Brigade works alongside you: teammates start on their own (an email, a failed payment, a schedule), and the App actions you choose wait for your yes. It runs on your own Claude or ChatGPT plan, takes no share of revenue, and is open source.',
    rows: [
      row('What it is', BRIGADE.what, 'A hosted platform that operates a business autonomously.'),
      row(
        'How it works',
        'In threads with you; teammates also start on their own from triggers and schedules.',
        'An autonomous nightly cycle, with a morning report.',
      ),
      row(
        'How you stay in control',
        BRIGADE.control,
        'You read what it did in the morning report.',
        'no',
      ),
      row('Who pays for AI', BRIGADE.bill, 'Included in Polsia’s plan.'),
      row(
        'Price',
        BRIGADE.price,
        'Most often reported at $49 a month plus 20% of revenue; changed several times in 2026.',
        'no',
      ),
      row('Open source', BRIGADE.open, 'No.', 'no'),
    ],
    pickThem: ['You want a business run for you with as little involvement as possible.'],
    pickBrigade: [
      'You run your own company and want to keep the decisions.',
      'You do not want to give a share of your revenue.',
      'You want to use the AI plan you already pay for, and read the code.',
    ],
    sources: [
      { label: 'polsia.com', url: 'https://polsia.com' },
      {
        label: 'Pulse 2.0: Polsia raises $30 million',
        url: 'https://pulse2.com/polsia-30-million-at-250-million-valuation-raised-for-ai-operations-platform/',
      },
      { label: 'Carly: Polsia pricing', url: 'https://www.usecarly.com/blog/polsia-pricing/' },
    ],
  },
  {
    slug: 'claude-code',
    name: 'Claude Code and Codex alone',
    logos: [{ harness: 'claude_code' }, { harness: 'codex' }],
    oneLiner:
      'Coding agents you run yourself, versus the same Claude Code and Codex run as a team with jobs, Apps, shared memory and one list of decisions.',
    about:
      'Claude Code (Anthropic) and Codex (OpenAI) are coding agents that run in a terminal, an editor or their own desktop apps, each on its own provider’s plan, with several sessions side by side.',
    answer:
      'Brigade does not replace Claude Code or Codex: each Brigade teammate is one of them, signed in with your account. What Brigade adds is the team around them: a job per teammate, its own computer and Apps, shared memory and skills, triggers and schedules, and one Needs you list for every decision, shared with the people you work with. Use both plans in one place, and stack several accounts of a provider so a teammate carries on when one hits its limit.',
    rows: [
      row('What it is', BRIGADE.what, 'An AI coding agent, with several sessions side by side.'),
      row('Jobs it covers', BRIGADE.jobs, 'Code first; also general tasks on your computer.'),
      row(
        'Providers',
        'Claude and ChatGPT plans side by side; a model per teammate.',
        'One provider each.',
        'partly',
      ),
      row('Decisions that need you', BRIGADE.control, 'Asked inside each session.', 'partly'),
      row(
        'Starts on its own',
        'Yes: triggers (an email, a webhook, a failed payment) and schedules.',
        'Through each provider’s own automations, where it offers them.',
        'partly',
      ),
      row(
        'Your team',
        'Threads, lists, the library and memory are shared with your workspace.',
        'Built around one person’s own sessions.',
        'no',
      ),
    ],
    pickThem: ['You code alone, and your own Claude Code or Codex sessions are all you need.'],
    pickBrigade: [
      'You have several sessions open and lose track of which does what.',
      'You want agents for support, marketing and sales too, not just code.',
      'You want them to start on their own, with the App actions you choose waiting for your yes.',
    ],
    sources: [
      { label: 'Claude Code', url: 'https://www.anthropic.com/claude-code' },
      { label: 'Codex', url: 'https://openai.com/codex/' },
    ],
  },
]

export const findComparison = (slug: string) => COMPARISONS.find((x) => x.slug === slug)
