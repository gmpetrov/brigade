// www.brigade.lol/llms.txt (llmstxt.org): what Brigade is, in plain Markdown, for AI agents
// and assistants that read it, with links to the pages that say more. Built with the site.
// Every claim here must hold in the code and docs, like the landing page's.
import { COMPARISONS } from '@/lib/compare'
import { DOCS_GROUPS, DOCS_URL, docsUrl } from '@/lib/docs-pages'
import { REPO_URL } from '@/lib/github-proof'
import { SITE_URL } from '@/lib/page-metadata'

export const dynamic = 'force-static'
export const revalidate = false

// The docs' page titles, by page, as in each .mdx file's front matter (a missing one shows
// the page's name).
const DOCS_TITLES: Record<string, string> = {
  index: 'What is Brigade?',
  quickstart: 'Quickstart',
  computers: 'Your computer or Brigade Cloud',
  concepts: 'Key concepts',
  teammates: 'Teammates',
  threads: 'Threads',
  'needs-you': 'Needs you and tickets',
  'ai-accounts': 'AI accounts',
  projects: 'Projects',
  lists: 'Lists',
  library: 'Library',
  memory: 'Memory',
  skills: 'Skills',
  routines: 'Routines',
  triggers: 'Triggers',
  playbooks: 'Playbooks',
  apps: 'Apps',
  email: 'Email',
  'code-and-previews': 'Code, pull requests and previews',
  members: 'Members and roles',
  notifications: 'Notifications',
  'usage-and-limits': 'Usage and limits',
  billing: 'Billing',
  security: 'Security and your data',
  'self-hosting': 'Self-hosting',
  faq: 'FAQ',
}

const docsSection = () =>
  DOCS_GROUPS.map(
    (g) =>
      `### ${g.group}\n\n` +
      g.pages.map((p) => `- [${DOCS_TITLES[p] ?? p}](${docsUrl(p)}.md)`).join('\n'),
  ).join('\n\n')

const body = () => `# Brigade

> Brigade is an open-source (MIT) app that gives a company a team of AI teammates for support, marketing, sales and code. Each teammate is the official Claude Code or Codex, signed in with the user's own Claude or ChatGPT plan, with a job, its own computer, the Apps it is given and a shared memory. Every decision that needs a person lands in one list, also on the phone. Free on your own computer; Brigade Cloud is $99 a month per workspace.

Website: ${SITE_URL}. Docs: ${DOCS_URL}. Source code: ${REPO_URL}. Live demo, no sign-up: https://demo.brigade.lol.

## Key facts

- What it is: an AI team for the whole company, not only a coding tool. Teammates answer customers, handle marketing, chase leads and write, test and ship code.
- Runs on: the official Claude Code (on a Claude plan) and Codex (on a ChatGPT plan), signed in with the user's own accounts. A model per teammate. Several accounts of the same provider can be stacked: when one hits its limit, the teammate carries on with the next.
- AI cost: Brigade never bills for AI usage; the work runs on the plan the user already pays for.
- Control: for each teammate, the user chooses what it does on its own and what waits for a yes (sending an email, a change in Stripe, shipping code), which Apps it can reach, and daily caps. Requests land in one "Needs you" list, with push notifications on phone and computer.
- Starts on its own: from triggers (an email, a webhook, an App event such as a failed payment) and schedules.
- Apps: Gmail, Google Calendar, Drive, Docs and Sheets, GitHub, Stripe, Notion, Linear, Atlassian, PostHog, Mixpanel, Google Analytics, Search Console, Ahrefs, Cloudflare, Vercel, Neon, Supabase, Resend and more, plus any MCP server and custom webhooks. With Cloud, each teammate can have its own email address.
- Teams: members share a workspace: threads, lists, the library of documents and memory.
- Where it runs: free on the user's own computer (macOS or Linux; Windows is not supported). Brigade Cloud ($99 a month per workspace) gives teammates a computer of their own that keeps working when the user's is off.
- Open source: the whole product is on GitHub under the MIT license and can be self-hosted.

## Who it is for

Founders and small teams who build with Claude Code or Codex and also run support, marketing and sales themselves; people who already pay for Claude Max or ChatGPT Pro and don't want a second AI bill; teams that want agents to start on their own but ask before they send, charge or ship.

## Limits

- On the free plan, teammates work only while the user's computer is on.
- Teammates run Claude Code or Codex; other harnesses and models are not supported yet.
- Users talk to teammates in Brigade's app (web, installable on the phone) and by email, not in WhatsApp or Telegram.

## Comparisons

${COMPARISONS.map((x) => `- [Brigade vs ${x.name}](${SITE_URL}/compare/${x.slug}): ${x.oneLiner}`).join('\n')}

## Docs

${docsSection()}

## Optional

- [Changelog](${SITE_URL}/changelog): what changed, week by week.
- [Full docs in one file](${DOCS_URL}/llms-full.txt)
- [Privacy policy](${SITE_URL}/privacy)
- [Terms](${SITE_URL}/terms)
`

export function GET() {
  return new Response(body(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
