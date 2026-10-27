// Which addresses sign in with a password: those whose account has one. Nobody can make one
// in production (sign-up with a password is off there, config.ts), so only accounts given a
// password by hand have one, such as the test account Google's app reviewers sign in with.
// The sign-in page asks before it shows the password field.
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import * as z from 'zod'

export const passwordSignIn = () =>
  ({
    id: 'password-sign-in',
    endpoints: {
      passwordSignIn: createAuthEndpoint(
        '/password-sign-in',
        { method: 'GET', query: z.object({ email: z.string().max(320) }) },
        async (c) => {
          const found = await c.context.internalAdapter.findUserByEmail(
            c.query.email.trim().toLowerCase(),
            { includeAccounts: true },
          )
          const password = !!found?.accounts.some((account) => account.providerId === 'credential')
          return c.json({ password })
        },
      ),
    },
  }) satisfies BetterAuthPlugin
