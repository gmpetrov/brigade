// Signing in with an email: a one-time code mailed through Resend (better-auth's emailOTP,
// src/auth.ts). The same code signs up a new address, so an account is only ever made by
// someone who reads its mail. A code rather than a link: on an iPhone, a link in Mail opens
// Safari, never the dashboard installed on the home screen, which a code reaches as well.
import { createHash } from 'node:crypto'
import { addressOf } from './mail/names.js'
import { resendConfigured, sendEmail } from './mail/resend.js'

/** Minutes a code stays valid (emailOTP's expiresIn, in seconds there). */
export const CODE_MINUTES = 10

export function signInCodeMail(email: string, code: string) {
  return {
    from: `Brigade <${addressOf('noreply')}>`,
    to: [email],
    subject: `${code} is your Brigade code`,
    text: [
      `Your code to sign in to Brigade: ${code}`,
      '',
      `It works for ${CODE_MINUTES} minutes, once. If you didn't ask for it, ignore this email: nobody can sign in without the code.`,
    ].join('\n'),
  }
}

export async function sendSignInCode(email: string, code: string) {
  // Locally and in previews no mail leaves: the code is in the API's log.
  if (!resendConfigured()) return console.log(`sign-in code for ${email}: ${code}`)
  const key = createHash('sha256').update(`${email}\n${code}`).digest('hex')
  await sendEmail(signInCodeMail(email, code), `brigade-sign-in-${key}`)
}
