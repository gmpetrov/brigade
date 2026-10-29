// Where a person came from when they signed up (docs/analytics.md, "Attribution"). The landing
// page reads its utm_* parameters, the referrer's host and the first page seen, and passes them
// in the sign-up and sign-in links' address; the sign-up page sends them with the code
// (POST /api/auth/sign-in/email-otp, `signupSource`) or through Google's round trip (the OAuth
// state's `additionalData.signupSource`). Kept once on the user (User.attribution), never
// changed. All of it came from the browser: each value is checked and cut short here, and
// no full URL is ever kept.

export const CHANNELS = [
  'twitter',
  'google_organic',
  'hacker_news',
  'product_hunt',
  'github',
  'reddit',
  'linkedin',
  'ai_search',
  'other_search',
  'newsletter',
  'direct',
  'other',
] as const
export type Channel = (typeof CHANNELS)[number]

export type SignupSource = {
  channel: Channel
  source?: string
  medium?: string
  campaign?: string
  /** The referrer's host only, e.g. news.ycombinator.com. */
  referrer?: string
  /** The first page seen on the site, its path only. */
  landingPage?: string
}

/** A utm value as given, without what could not be a utm value. */
function utm(value: unknown) {
  if (typeof value !== 'string') return undefined
  const clean = value
    .trim()
    .replace(/[^\p{L}\p{N} ._~+:/@-]/gu, '')
    .slice(0, 80)
  return clean || undefined
}

/** A host name, lowercase, without www., or nothing when it is not one. */
export function hostOf(value: unknown) {
  if (typeof value !== 'string') return undefined
  let host = value.trim().toLowerCase()
  // A URL given instead of a host: its host only.
  if (host.includes('/')) {
    try {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname
    } catch {
      return undefined
    }
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  if (host.length > 120 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return undefined
  return host
}

/** A path on the site, without its query or fragment. */
function pathOf(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//'))
    return undefined
  const path = value.split(/[?#]/)[0]!.slice(0, 120)
  return /^\/[A-Za-z0-9/_.-]*$/.test(path) ? path : undefined
}

const is = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** The channel a referrer's host stands for (the plan's table), or 'other'. */
export function channelOfReferrer(host: string, paid = false): Channel {
  if (is(host, 'x.com') || is(host, 't.co') || is(host, 'twitter.com')) return 'twitter'
  if (
    is(host, 'chatgpt.com') ||
    is(host, 'chat.openai.com') ||
    is(host, 'perplexity.ai') ||
    is(host, 'claude.ai') ||
    is(host, 'gemini.google.com')
  )
    return 'ai_search'
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return paid ? 'other' : 'google_organic'
  if (is(host, 'news.ycombinator.com')) return 'hacker_news'
  if (is(host, 'producthunt.com')) return 'product_hunt'
  if (is(host, 'github.com')) return 'github'
  if (is(host, 'reddit.com')) return 'reddit'
  if (is(host, 'linkedin.com') || is(host, 'lnkd.in')) return 'linkedin'
  if (is(host, 'bing.com') || is(host, 'duckduckgo.com')) return 'other_search'
  return 'other'
}

/** The channel a utm_source names (with its medium), from the usual ways of writing it. */
export function channelOfUtm(source: string, medium?: string): Channel {
  const s = source.toLowerCase().replace(/[\s_-]+/g, '')
  const m = (medium ?? '').toLowerCase()
  if (['x', 'twitter', 'tco', 'x.com', 'twitter.com'].includes(s)) return 'twitter'
  if (['hn', 'hackernews', 'ycombinator', 'news.ycombinator.com'].includes(s)) return 'hacker_news'
  if (['ph', 'producthunt', 'producthunt.com'].includes(s)) return 'product_hunt'
  if (['github', 'github.com', 'gh'].includes(s)) return 'github'
  if (['reddit', 'reddit.com'].includes(s)) return 'reddit'
  if (['linkedin', 'linkedin.com', 'lnkd.in'].includes(s)) return 'linkedin'
  if (['chatgpt', 'openai', 'perplexity', 'claude', 'gemini', 'chatgpt.com'].includes(s))
    return 'ai_search'
  if (s === 'google')
    return ['cpc', 'ppc', 'paid', 'paidsearch'].includes(m) ? 'other' : 'google_organic'
  if (['bing', 'duckduckgo', 'ddg'].includes(s)) return 'other_search'
  if (s === 'newsletter' || m === 'email' || m === 'newsletter') return 'newsletter'
  // A host given as the source: as its referrer would be.
  const host = hostOf(source)
  if (host) return channelOfReferrer(host)
  return 'other'
}

/**
 * What the browser sent, checked: utm_source, utm_medium, utm_campaign, ref (the referrer's
 * host), lp (the first page) and paid (a click id was in the address). Anything else is
 * dropped. The channel is utm_source's when there is one, else the referrer's, else direct.
 */
export function parseSignupSource(raw: unknown): SignupSource {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const source = utm(input.utm_source)
  const medium = utm(input.utm_medium)
  const campaign = utm(input.utm_campaign)
  const referrer = hostOf(input.ref)
  const landingPage = pathOf(input.lp)
  const paid = input.paid === true || input.paid === '1'
  const channel: Channel = source
    ? channelOfUtm(source, medium)
    : referrer
      ? channelOfReferrer(referrer, paid)
      : 'direct'
  return {
    channel,
    ...(source && { source }),
    ...(medium && { medium }),
    ...(campaign && { campaign }),
    ...(referrer && { referrer }),
    ...(landingPage && { landingPage }),
  }
}

/** The person's properties for PostHog, set once at sign-up. */
export function signupProperties(source: SignupSource, method: string) {
  return {
    signup_channel: source.channel,
    signup_method: method,
    ...(source.source && { signup_source: source.source }),
    ...(source.medium && { signup_medium: source.medium }),
    ...(source.campaign && { signup_campaign: source.campaign }),
    ...(source.referrer && { signup_referrer: source.referrer }),
    ...(source.landingPage && { signup_landing_page: source.landingPage }),
  }
}
