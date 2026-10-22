import { DEMO, DEMO_API } from './demo/flag'

export const API_URL = DEMO
  ? DEMO_API
  : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001')
export const WS_URL = API_URL.replace(/^http/, 'ws')

// Before anything here asks the API: in the demo, the browser answers it. A require, in a
// branch the build drops unless NEXT_PUBLIC_DEMO=1: other builds carry none of the demo.
if (process.env.NEXT_PUBLIC_DEMO === '1' && typeof window !== 'undefined')
  (require('./demo/install') as typeof import('./demo/install')).installDemo()
