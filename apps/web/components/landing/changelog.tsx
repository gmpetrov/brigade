import type { Metadata } from 'next'

export const SITE = 'https://www.brigade.lol'
export const FEED_PATH = '/changelog/rss.xml'

/** A changelog page's metadata, with its RSS feed for readers to find. */
export function changelogMetadata(path: string, title: string, description: string): Metadata {
  const url = `${SITE}${path}`
  return {
    title,
    description,
    alternates: { canonical: url, types: { 'application/rss+xml': `${SITE}${FEED_PATH}` } },
    openGraph: { type: 'article', url, siteName: 'Brigade', title, description },
    twitter: { card: 'summary', title, description },
  }
}
