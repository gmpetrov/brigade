import { LegalPage, legalMetadata } from '@/components/landing/legal'
import { REPO_URL } from '@/lib/github-proof'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = legalMetadata(
  '/privacy',
  'Privacy policy · Brigade',
  'What Brigade stores about you and your workspace, why, and how to have it deleted.',
)

export default function Privacy() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        Brigade gives your company AI teammates. This page explains what we store to run it, and
        what we don&apos;t do with it.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          <strong>Your account:</strong> your name, email address and profile picture, from the
          sign-up form or from Google when you sign in with Google.
        </li>
        <li>
          <strong>Your workspace:</strong> threads, messages, files you attach, library documents,
          tasks, skills, schedules and the settings of your teammates.
        </li>
        <li>
          <strong>Apps and secrets:</strong> the accounts you connect (such as GitHub or Gmail) and
          the credentials you save to the vault. Secrets are stored encrypted, and nobody, teammates
          included, can read them back.
        </li>
        <li>
          <strong>Your devices:</strong> the computers you link to Brigade, and a push subscription
          when you turn on notifications.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Only to run Brigade for you: show your workspace, let your teammates do the work you ask
        for, and send the notifications you chose. We don&apos;t sell your data, show ads, or use
        your content to train AI models.
      </p>

      <h2>AI models</h2>
      <p>
        Your teammates run on your own Claude or Codex subscription, on your Mac or on
        Brigade&apos;s cloud computer. What they read and write is sent to that provider under your
        account with them, and their own privacy policy applies.
      </p>

      <h2>Where it lives</h2>
      <p>
        Brigade runs on Cloudflare. Files are kept in Cloudflare R2 and the database with our
        hosting provider. When you delete a thread, its files are deleted too.
      </p>

      <h2>Your choices</h2>
      <p>
        You can disconnect an App, delete a secret or a thread at any time from the dashboard. To
        delete your account and workspace, or for any question about your data, contact us through{' '}
        <a href={`${REPO_URL}/issues`}>GitHub</a>.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, we update this page and the date at the top of it.</p>
    </LegalPage>
  )
}
