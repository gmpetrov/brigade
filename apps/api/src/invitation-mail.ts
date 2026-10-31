// The mail an invitation sends (better-auth's organization plugin, src/auth.ts): who invites,
// to which organization, and a link to /invite/<id>, where the invited person signs in with
// that address (Google or a code) and joins. Only the address's proven owner can take it.
import { env } from './config.js'
import { addressOf } from './mail/names.js'
import { resendConfigured, sendEmail } from './mail/resend.js'

/** Days an invitation stays open (the plugin's invitationExpiresIn, in seconds there). */
export const INVITATION_DAYS = 7

export const invitationLink = (id: string) => `${env.WEB_URL[0]}/invite/${encodeURIComponent(id)}`

export function invitationMail(input: {
  id: string
  email: string
  role: string
  organization: string
  inviter: { name: string; email: string }
}) {
  const inviter = input.inviter.name.trim() || input.inviter.email
  const as =
    input.role === 'member'
      ? ''
      : ` as ${input.role === 'owner' ? 'an owner' : input.role === 'admin' ? 'an admin' : 'a viewer, who can look but not change anything'}`
  return {
    from: `Brigade <${addressOf('noreply')}>`,
    to: [input.email],
    reply_to: [input.inviter.email],
    subject: `${inviter} invited you to ${input.organization} on Brigade`,
    text: [
      `${inviter} (${input.inviter.email}) invited you to join ${input.organization} on Brigade${as}.`,
      '',
      `Join: ${invitationLink(input.id)}`,
      '',
      `Sign in there as ${input.email}, with Google or a code mailed to you. The invitation is open for ${INVITATION_DAYS} days. If you didn't expect it, ignore this email.`,
    ].join('\n'),
  }
}

export async function sendInvitation(input: Parameters<typeof invitationMail>[0]) {
  // Locally and in previews no mail leaves: the link is in the API's log.
  if (!resendConfigured())
    return console.log(`invitation for ${input.email}: ${invitationLink(input.id)}`)
  // Each sending its own key: sending again (Resend in Settings › Members) mails it again.
  await sendEmail(invitationMail(input), `brigade-invitation-${input.id}-${Date.now()}`)
}
