import type { Metadata } from 'next'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

export const FEED_PATH = '/changelog/rss.xml'

/** A changelog page's metadata, with its RSS feed for readers to find. */
export function changelogMetadata(path: string, title: string, description: string): Metadata {
  const page = pageMetadata(path, title, description)
  return {
    ...page,
    alternates: { ...page.alternates, types: { 'application/rss+xml': `${SITE_URL}${FEED_PATH}` } },
  }
}
