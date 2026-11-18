// www.brigade.lol/docs/llms.txt: Mintlify's, with its links on the site (lib/docs-index.ts).
import { docsIndex } from '@/lib/docs-index'

export const dynamic = 'force-dynamic'

export const GET = () => docsIndex('llms.txt')
