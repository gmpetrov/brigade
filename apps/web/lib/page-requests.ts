// The API requests a dashboard page makes as it opens, named once for both ends: the page's
// HTML asks the browser to send them as it arrives (app/app/layout.tsx, the thread's page),
// and the page's own requests, made once its scripts have run (about 150 ms later from
// France, 300 through a VPN in Los Angeles), take the answers. The browser matches them by
// address and credentials: a path asked for differently would be asked for twice.
import { preload } from 'react-dom'
import { API_URL } from './config'

/**
 * What every page asks for: the member and the shell's lists (components/dashboard.tsx), and
 * every thread, for the thread panel (components/thread-panel.tsx).
 */
export const EVERY_PAGE = [
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

/** Has the page's HTML send these GET requests to the API, for `api()` to take (lib/api.ts). */
export function sendAhead(paths: string[]) {
  for (const path of paths)
    preload(`${API_URL}/api${path}`, { as: 'fetch', crossOrigin: 'use-credentials' })
}
