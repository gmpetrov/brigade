import type { Metadata } from 'next'

export const SITE_URL = 'https://www.brigade.lol'

// app/opengraph-image.png, named again on each page: a page that sets its own `openGraph`
// replaces the root's, image included (Next merges metadata shallowly).
const image = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'Brigade: AI teammates that run your whole company',
}

/** A public page's title, description, canonical address and link preview. */
export function pageMetadata(path: string, title: string, description: string): Metadata {
  const url = path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: 'Brigade', title, description, images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  }
}

/** Pages behind a sign-in, or with nothing to find: kept out of search results. */
export const PRIVATE_PAGE: Metadata = { robots: { index: false, follow: false } }
