import Link from 'next/link'
import { LegalPage } from '@/components/landing/legal'
import { OPERATOR } from '@/components/landing/operator'
import { pageMetadata } from '@/lib/page-metadata'

const CONTACT = OPERATOR.email

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = pageMetadata(
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

      <h2>Who we are</h2>
      <p>
        {OPERATOR.company
          ? `Brigade is run by ${OPERATOR.company.name}, ${OPERATOR.company.address}. `
          : ''}
        We are the controller of your account data and of the data we need to run and bill the
        service. For what you and your teammates put in a workspace, we act on your company&apos;s
        behalf, as a processor: our <Link href="/dpa">data processing agreement</Link> covers it.
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
        <li>
          <strong>Sign-in and security:</strong> the IP address and browser of each session, the
          codes we email you to sign in (they expire within minutes), and counts of recent attempts,
          to stop abuse.
        </li>
        <li>
          <strong>Email:</strong> mail your teammates send and receive at their Brigade addresses.
        </li>
        <li>
          <strong>Cloud computer:</strong> what your teammates keep on it, and an encrypted copy of
          its Claude or Codex sign-in, so a new machine can take over when we replace it.
        </li>
        <li>
          <strong>Billing:</strong> your plan, invoices and the email of who pays. Stripe keeps the
          card details.
        </li>
        <li>
          <strong>Usage:</strong> where you came from when you signed up (such as the site that
          linked to us, or a campaign&apos;s name in the link), and which features you use and when.
          Never the content of your workspace or your email address.
        </li>
      </ul>
      <p>
        We set only the cookies Brigade needs to work, such as the one that keeps you signed in. We
        don&apos;t use advertising or tracking cookies.
      </p>
      <p>
        We use PostHog, in the EU, to measure visits and how Brigade is used. On this website it
        runs without cookies or any storage in your browser, and it doesn&apos;t record your screen.
        From Brigade itself we send it only pseudonymous ids, counts and the kind of each action
        (such as &ldquo;a thread started&rdquo;), never your content, names or email address. When
        Brigade hits an error, we also send it the error&apos;s message, with email addresses and
        links removed, and the place in Brigade&apos;s code where it happened, so we can fix it.
      </p>

      <h2>How we use it</h2>
      <p>
        Only to run Brigade for you: show your workspace, let your teammates do the work you ask
        for, and send the notifications you chose. We don&apos;t sell your data, show ads, or use
        your content to train AI models.
      </p>
      <p>
        We do this to perform our contract with you (running your account and workspace, billing),
        for our legitimate interest in keeping Brigade secure and preventing abuse and in measuring
        how people find and use Brigade to improve it, to meet legal obligations (such as keeping
        invoices), and with your consent where we ask for it (such as notifications).
      </p>

      <h2>AI models</h2>
      <p>
        Your teammates run on your own Claude or Codex subscription, on your computer or on
        Brigade&apos;s cloud computer. What they read and write is sent to Anthropic or OpenAI under
        your account with them, and their own privacy policy applies: they are your providers, not
        ours.
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
          <strong>Cloudflare:</strong> runs Brigade, keeps your files (Cloudflare R2) and checks
          sign-ups for bots.
        </li>
        <li>
          <strong>Neon:</strong> hosts Brigade&apos;s database, in the EU (Frankfurt).
        </li>
        <li>
          <strong>Boat:</strong> runs the cloud computer your teammates work on, in the EU, when
          your workspace has one.
        </li>
        <li>
          <strong>Resend:</strong> sends and receives Brigade&apos;s email, such as sign-in codes
          and your teammates&apos; mail.
        </li>
        <li>
          <strong>Stripe:</strong> handles payments. We never see your card number.
        </li>
        <li>
          <strong>PostHog:</strong> measures visits and feature usage, in the EU, without your
          content or email address, and collects reports of the errors Brigade hits.
        </li>
        <li>
          <strong>Google:</strong> when you sign in with Google or connect a Google App.
        </li>
        <li>
          <strong>GitHub:</strong> when you connect your repositories.
        </li>
        <li>
          <strong>Your browser&apos;s push service</strong> (Apple, Google or Mozilla): the
          notifications you turned on.
        </li>
      </ul>
      <p>
        The <Link href="/subprocessors">list of subprocessors</Link> says where each one is and what
        it does. Some of them are in the United States: transfers there rely on the EU-US Data
        Privacy Framework or the European Commission&apos;s standard contractual clauses. We
        don&apos;t sell your data or share it with anyone else, unless the law requires it.
      </p>

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
        <a href="https://myaccount.google.com/permissions">your Google account</a>.
      </p>
      <p>
        An owner can delete a workspace, and you can delete your account, in Settings. Deleting a
        workspace deletes its threads, files, library, teammates and Apps, and destroys its cloud
        computer; deleting your account deletes your profile and the threads you started. Files go
        from storage within hours. Copies in our database backups expire within 30 days. We keep
        invoices for 10 years, as French law requires, and a short record that the workspace was
        deleted and by whom.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask us to access, correct, delete or export your personal data, to restrict how we
        use it, or object to it, by emailing <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We answer
        within a month. If your data is in a workspace someone else&apos;s company runs, we may pass
        your request on to them. You can also complain to the French data protection authority, the{' '}
        <a href="https://www.cnil.fr/en/contact-cnil">CNIL</a>, or the one where you live.
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
