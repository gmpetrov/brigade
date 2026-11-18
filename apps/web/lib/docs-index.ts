// The docs' indexes for AI agents (llms.txt and llms-full.txt), as Mintlify builds them with
// each page's link on its own subdomain (brigade.mintlify.dev). Teammates and assistants follow
// those links and then quote them, so the site serves both files itself, with every link at
// www.brigade.lol/docs, where the docs are proxied (next.config.ts).
import { SITE_URL } from './page-metadata'

export const MINTLIFY_DOCS = 'https://brigade.mintlify.site/docs'

/** The text with Mintlify's own addresses of the docs replaced by www.brigade.lol's. */
export const onSiteDocsLinks = (text: string) =>
  text.replace(/https:\/\/brigade\.mintlify\.(?:dev|site|app)\b/g, SITE_URL)

/** One of the docs' index files, fetched from Mintlify with its links on the site. */
export async function docsIndex(file: 'llms.txt' | 'llms-full.txt') {
  const res = await fetch(`${MINTLIFY_DOCS}/${file}`)
  if (!res.ok) return new Response('Not found', { status: res.status === 404 ? 404 : 502 })
  return new Response(onSiteDocsLinks(await res.text()), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
