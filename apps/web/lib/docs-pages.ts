// The public docs' pages (apps/docs, served by Mintlify at www.brigade.lol/docs), read from
// its navigation at build: the sitemap and llms.txt list them under www.brigade.lol, the
// address search engines should keep (docs.json's canonical says the same).
import docs from '../../docs/docs.json'
import { SITE_URL } from './page-metadata'

type Group = { group: string; pages: string[] }

export const DOCS_URL = `${SITE_URL}/docs`

export const DOCS_GROUPS: Group[] = (docs.navigation.groups as Group[]).map((g) => ({
  group: g.group,
  pages: g.pages,
}))

/** A docs page's address: `index` is the docs' home. */
export const docsUrl = (page: string) => (page === 'index' ? DOCS_URL : `${DOCS_URL}/${page}`)

export const DOCS_PAGES = DOCS_GROUPS.flatMap((g) => g.pages)
