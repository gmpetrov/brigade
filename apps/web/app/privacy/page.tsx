import { LegalPage, legalMetadata } from '@/components/landing/legal'

const CONTACT = 'support@brigade.lol'

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

      <h2>Data from Google</h2>
      <p>
        When you connect a Google App, Brigade asks only for the access that App needs, and uses it
        only for the work you or your teammates ask for:
      </p>
      <ul>
        <li>
          <strong>Google Docs and Google Sheets:</strong> to read, edit and create the documents and
          spreadsheets you give a teammate, by link or because it made them.
        </li>
        <li>
          <strong>Google Analytics and Search Console:</strong> to read the reports of the
          properties and sites you connect.
        </li>
        <li>
          <strong>Gmail, Google Calendar and Google Drive:</strong> to read, send and organize the
          mail, events and files of the account you connect, as you ask.
        </li>
      </ul>
      <p>
        Your Google sign-in tokens are kept encrypted in the vault. What a teammate reads or writes
        with them is kept in the thread where it did the work, until you delete that thread, and is
        sent to your Claude or Codex subscription only to do that work. We don&apos;t use data from
        Google for ads, sell it, use it to train AI models, or let anyone read it, except when you
        ask us to for support, for security, or when the law requires it.
      </p>
      <p>
        Brigade&apos;s use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
      <p>
        Brigade does not use Google Workspace data obtained through Google APIs to develop, improve
        or train generalized AI or machine learning models.
      </p>

      <h2>Who we share it with</h2>
      <p>
        We share your data only with the services that run Brigade for us, and only what each needs:
      </p>
      <ul>
        <li>
          <strong>Anthropic or OpenAI:</strong> what your teammates read and write, under your own
          Claude or Codex subscription.
        </li>
        <li>
          <strong>Cloudflare:</strong> runs Brigade and keeps your files (Cloudflare R2).
        </li>
        <li>
          <strong>Neon:</strong> hosts Brigade&apos;s database.
        </li>
        <li>
          <strong>Our cloud computer provider:</strong> runs the cloud computer your teammates work
          on, when your workspace has one.
        </li>
        <li>
          <strong>Resend:</strong> sends and receives Brigade&apos;s email, such as sign-in codes
          and your teammates&apos; mail.
        </li>
        <li>
          <strong>Stripe:</strong> handles payments. We never see your card number.
        </li>
      </ul>
      <p>We don&apos;t sell your data or share it with anyone else.</p>

      <h2>How we protect it</h2>
      <ul>
        <li>All traffic to and from Brigade is encrypted (HTTPS).</li>
        <li>
          Secrets and App tokens are encrypted in the vault with a key kept apart from the database,
          and nobody, teammates included, can read them back.
        </li>
        <li>
          Each workspace&apos;s data is kept apart from the others, and only its members and the
          teammates they allow can reach it.
        </li>
        <li>Only the people who run Brigade can reach its systems, for operations and support.</li>
      </ul>

      <h2>Keeping and deleting it</h2>
      <p>
        We keep your data while your account exists. You can disconnect an App, delete a secret or a
        thread at any time from the dashboard: disconnecting a Google App also revokes
        Brigade&apos;s access in your Google account, and deleting a thread deletes its files. You
        can also remove Brigade&apos;s access at any time from{' '}
        <a href="https://myaccount.google.com/permissions">your Google account</a>. To delete your
        account and workspace, email us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a>: we delete
        them within 30 days.
      </p>

      <h2>Contact</h2>
      <p>
        For any question about your data, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, we update this page and the date at the top of it.</p>
    </LegalPage>
  )
}
