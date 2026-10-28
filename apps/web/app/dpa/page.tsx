import Link from 'next/link'
import { LegalPage, legalMetadata } from '@/components/landing/legal'
import { OPERATOR } from '@/components/landing/operator'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = legalMetadata(
  '/dpa',
  'Data processing agreement · Brigade',
  'How Brigade processes personal data on behalf of its customers, under Article 28 of the GDPR.',
)

export default function Dpa() {
  return (
    <LegalPage title="Data processing agreement">
      <p>
        This agreement is part of Brigade&apos;s <Link href="/terms">terms of service</Link>,
        between the customer who accepted them (the controller) and {OPERATOR.name} (Brigade, the
        processor). It applies when Brigade processes personal data on the customer&apos;s behalf,
        under the EU General Data Protection Regulation (GDPR) and the laws that apply it. Nothing
        needs to be signed; a customer who wants a signed copy can ask at{' '}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>.
      </p>

      <h2>1. What Brigade processes</h2>
      <ul>
        <li>
          <strong>Subject and purpose:</strong> hosting the customer&apos;s workspace and running
          its AI teammates, as the customer and its members ask.
        </li>
        <li>
          <strong>Duration:</strong> as long as the customer uses Brigade, then until the data is
          deleted as section 8 says.
        </li>
        <li>
          <strong>Data:</strong> whatever the customer, its members and its teammates put in the
          workspace: messages, files, documents, email, the content of connected Apps, credentials
          kept in the vault, and the members&apos; names and email addresses.
        </li>
        <li>
          <strong>People concerned:</strong> the customer&apos;s members, and the people that
          content is about, such as its customers, contacts and correspondents.
        </li>
        <li>
          <strong>Special categories:</strong> Brigade is not meant for them; the customer decides
          whether to put any in a workspace, and takes the measures they need.
        </li>
      </ul>

      <h2>2. Instructions</h2>
      <p>
        Brigade processes the data only on the customer&apos;s documented instructions: these terms,
        and what the customer and its members ask in the dashboard, including the work they give
        their teammates. Brigade tells the customer if it believes an instruction breaks data
        protection law, and processes data otherwise only where the law requires it, telling the
        customer unless that law forbids it.
      </p>
      <p>
        The customer is responsible for having a lawful basis for the data it puts in Brigade, and
        for the access it gives its teammates (its Apps, accounts and computers).
      </p>

      <h2>3. Confidentiality</h2>
      <p>
        Only the people who run Brigade can reach its systems, for operations and support, and each
        of them is bound to confidentiality.
      </p>

      <h2>4. Security</h2>
      <p>Brigade protects the data with measures fitting the risk, including:</p>
      <ul>
        <li>encryption in transit (HTTPS) everywhere, and at rest by our hosting providers;</li>
        <li>
          secrets and App tokens sealed in the vault with a key kept apart from the database, which
          nobody, teammates included, can read back;
        </li>
        <li>each workspace kept apart from the others in every request and stored file;</li>
        <li>
          sign-in by Google or by a code sent to the member&apos;s email, with limits on attempts;
        </li>
        <li>
          cloud computers run teammates as separate system users, and each preview address opens
          only with a short-lived token;
        </li>
        <li>database backups, and access to production restricted to the people who run it.</li>
      </ul>

      <h2>5. Subprocessors</h2>
      <p>
        The customer allows Brigade to use the subprocessors on the{' '}
        <Link href="/subprocessors">list of subprocessors</Link>. Brigade binds each to data
        protection terms at least as protective as these, and remains responsible for them. Brigade
        updates the list before a new subprocessor gets the data; the customer can object within 30
        days for a reasonable data protection reason, and if no solution is found, either side can
        end the subscription, with the unused part of a prepaid month refunded.
      </p>
      <p>
        Anthropic and OpenAI are not Brigade&apos;s subprocessors: teammates send them data under
        each member&apos;s own account with them. The same goes for the Apps the customer connects.
      </p>

      <h2>6. Transfers outside the EU</h2>
      <p>
        Where a subprocessor processes data outside the European Economic Area, the transfer relies
        on an adequacy decision (such as the EU-US Data Privacy Framework) or the European
        Commission&apos;s standard contractual clauses.
      </p>

      <h2>7. Helping the customer</h2>
      <p>
        Most requests from the people concerned can be answered in the dashboard (a thread, a file
        or a whole workspace can be deleted there). Brigade helps the customer with the rest, and
        with its security, impact assessments and consultations with authorities, as far as it
        reasonably can given what it knows. Brigade passes on any request it receives directly about
        the customer&apos;s data.
      </p>
      <p>
        Brigade tells the customer without undue delay, and within 48 hours, after learning of a
        personal data breach affecting its data, with what it knows then and what it does about it,
        and keeps it informed.
      </p>

      <h2>8. End of the service</h2>
      <p>
        When the customer deletes its workspace, or its account is closed, Brigade deletes the data:
        from its live systems at once, from storage within hours, and from backups as they expire,
        within 30 days. Before that, the customer can download its files from the dashboard. Brigade
        keeps only what the law requires it to (such as invoices).
      </p>

      <h2>9. Audits</h2>
      <p>
        Brigade gives the customer the information needed to show it meets this agreement, and
        answers reasonable written questions. Where that is not enough, or an authority requires it,
        the customer may have an audit done, at its own cost, by an independent auditor bound to
        confidentiality, at most once a year and with 30 days&apos; notice.
      </p>

      <h2>10. Everything else</h2>
      <p>
        The terms of service govern the rest, including liability and law. If they conflict with
        this agreement about personal data, this agreement prevails.
      </p>
    </LegalPage>
  )
}
