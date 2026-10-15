import { redirectIfSignedInScript } from '@/lib/signed-in'

/** Sends a signed-in browser on to /app before the page paints (lib/signed-in.ts). */
export function RedirectIfSignedIn() {
  return <script dangerouslySetInnerHTML={{ __html: redirectIfSignedInScript }} />
}
