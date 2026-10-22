// Brigade.app's window signs in through the browser: its embedded WebKit keeps cookies of
// its own, so the browser's session is out of its reach, and a form there would ask again.
//
// 1. The app makes a secret verifier and opens the browser on /app/desktop-sign-in with
//    its hash (the challenge).
// 2. There, signed in, the member continues: the browser's session issues a one-time code
//    bound to the challenge (POST /api/auth/desktop/code) and hands it to the app as
//    brigade://sign-in?code=….
// 3. The app's window redeems the code with the verifier (POST /api/auth/desktop/redeem),
//    which signs it in with a session of its own.
//
// Another app that took brigade:// links would get the code but not the verifier, which
// never leaves Brigade.app. A code is used once, whatever the verifier, and expires soon.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import * as z from 'zod'

const CODE_MINUTES = 5
const identifier = (code: string) =>
  `desktop-sign-in:${createHash('sha256').update(code).digest('hex')}`

/** The challenge of a verifier, as the app computes it: base64url of its SHA-256. */
export const challengeOf = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

/** base64url of 32 bytes, as the app's verifier and its challenge are. */
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

type Grant = { userId: string; activeWorkspaceId: string | null; challenge: string }

export const desktopSignIn = () =>
  ({
    id: 'desktop-sign-in',
    endpoints: {
      issueDesktopCode: createAuthEndpoint(
        '/desktop/code',
        { method: 'POST', body: z.object({ challenge: secret }), use: [sessionMiddleware] },
        async (c) => {
          const { session } = c.context.session
          const code = randomBytes(32).toString('base64url')
          const grant: Grant = {
            userId: session.userId,
            activeWorkspaceId:
              (session as { activeWorkspaceId?: string | null }).activeWorkspaceId ?? null,
            challenge: c.body.challenge,
          }
          await c.context.internalAdapter.createVerificationValue({
            identifier: identifier(code),
            value: JSON.stringify(grant),
            expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
          })
          return c.json({ code })
        },
      ),
      redeemDesktopCode: createAuthEndpoint(
        '/desktop/redeem',
        { method: 'POST', body: z.object({ code: z.string().min(1).max(100), verifier: secret }) },
        async (c) => {
          const invalid = () =>
            c.error('BAD_REQUEST', { message: 'This sign-in link is invalid or has expired' })
          // Used up whatever happens next: a wrong verifier does not get to try again.
          const row = await c.context.internalAdapter.consumeVerificationValue(
            identifier(c.body.code),
          )
          if (!row || row.expiresAt < new Date()) throw invalid()
          const grant = JSON.parse(row.value) as Grant
          const given = Buffer.from(challengeOf(c.body.verifier))
          const wanted = Buffer.from(grant.challenge)
          if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw invalid()
          const user = await c.context.internalAdapter.findUserById(grant.userId)
          if (!user) throw invalid()
          const session = await c.context.internalAdapter.createSession(user.id, false, {
            activeWorkspaceId: grant.activeWorkspaceId,
          })
          await setSessionCookie(c, { session, user })
          return c.json({ ok: true })
        },
      ),
    },
  }) satisfies BetterAuthPlugin
