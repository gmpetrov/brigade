import { DEMO, DEMO_API } from './demo/flag'
import { installDemo } from './demo/install'

export const API_URL = DEMO
  ? DEMO_API
  : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001')
export const WS_URL = API_URL.replace(/^http/, 'ws')

// Before anything here asks the API: in the demo, the browser answers it.
if (DEMO && typeof window !== 'undefined') installDemo()
