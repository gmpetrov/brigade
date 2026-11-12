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
}

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
