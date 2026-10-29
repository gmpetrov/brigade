// The site's public pages: the only ones its analytics may send from
// (components/landing/site-analytics.tsx), and the ones its sitemap lists (app/sitemap.ts).
// Never the sign-in pages, the dashboard or the demo.
export const PUBLIC_PAGES = [
  '/',
  '/how-it-works',
  '/privacy',
  '/terms',
  '/dpa',
  '/subprocessors',
  '/legal',
] as const

const pages = new Set<string>(PUBLIC_PAGES)

export const isPublicPage = (pathname: string) => pages.has(pathname.replace(/\/+$/, '') || '/')
