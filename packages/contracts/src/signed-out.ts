// Whether a harness's error says its login is gone. The API counts such failures to mark an
// account needs_sign_in (apps/api/src/account-health.ts); the dashboard offers to sign in again
// right in the thread when a turn fails with one.

/** Out of usage, rate-limited or out of credits: never a login that stopped working. */
const LIMITED =
  /usage limit|limit reached|hit your (usage )?limit|out of (usage|credits)|quota|rate.?limit|too many requests|\b429\b|credit balance|billing|overloaded/i

/** What harnesses say when they have no working login, and nothing else says. */
const SIGNED_OUT = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /oauth token (has )?(expired|been revoked|revoked|is invalid)/i,
  /authentication_error/i,
  /\b401\b[^\n]{0,80}(unauthori[sz]ed|authenticat|invalid[^\n]{0,20}(token|key|credential))/i,
  /(unauthori[sz]ed|authenticat)[^\n]{0,80}\b401\b/i,
  /refresh token (has )?(expired|was revoked|been revoked|is invalid|was already used|already been used)/i,
  /access token could not be refreshed/i,
  /authentication token is expired/i,
  /please (sign|log) ?in again/i,
]

/** Whether a harness's error says its login is gone. */
export const signedOut = (message: string) =>
  !LIMITED.test(message) && SIGNED_OUT.some((pattern) => pattern.test(message))
