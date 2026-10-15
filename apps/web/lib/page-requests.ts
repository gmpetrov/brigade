// The API requests a dashboard page makes as it opens, named once for both ends: the page's
// first script, inline in its HTML (app/layout.tsx), sends them as the page arrives, and the
// page's own requests, made once its scripts have run (about 150 ms later from France, 300
// through a VPN in Los Angeles), take the answers (lib/api.ts's `preloaded`). With fetch():
// Chrome sends `<link rel="preload">` fetches to a host three at a time. At low priority: on a
// connection Chrome finds slow, it holds low-priority requests while high-priority ones are
// out, and the page's own scripts (async, so low) then waited for these, from its cache.
import { API_URL } from './config'

/**
 * What every page asks for: the member and the shell's lists (components/dashboard.tsx), and
 * every thread, for the thread panel (components/thread-panel.tsx).
 */
const EVERY_PAGE = [
  '/me',
  '/teammates',
  '/projects',
  '/pulls/attention',
  '/tickets',
  '/tasks',
  '/threads',
]

/** A thread, as its conversation loads it (components/thread-conversation.tsx). */
export const threadPath = (id: string) => `/threads/${id}`

/** A thread's latest page of events and what it needs from before (lib/use-thread-events.ts). */
export const latestPagePath = (id: string) => `/threads/${id}/events`

/**
 * The script: on a dashboard page, every page's requests, and on a thread's page the thread's,
 * first. What is not taken within a few seconds goes, as it gets stale. Off in a browser with
 * localStorage['brigade.sendAhead'] = 'off', to compare (components/thread-conversation.tsx
 * marks when a thread shows).
 */
export const SEND_AHEAD = `(() => {
  const [, app, section, id, rest] = location.pathname.split('/')
  if (app !== 'app') return
  try {
    if (localStorage.getItem('brigade.sendAhead') === 'off') return
  } catch {}
  const thread = ${JSON.stringify([threadPath(':id'), latestPagePath(':id')])}
  const paths = [
    ...(section === 'threads' && id && !rest ? thread.map((path) => path.replace(':id', id)) : []),
    ...${JSON.stringify(EVERY_PAGE)},
  ]
  const sent = (window.__sentAhead = {})
  for (const path of paths) {
    sent[path] = fetch(${JSON.stringify(API_URL)} + '/api' + path, { credentials: 'include', priority: 'low' })
    sent[path].catch(() => {})
  }
  setTimeout(() => { for (const path in sent) delete sent[path] }, 10000)
})()`
