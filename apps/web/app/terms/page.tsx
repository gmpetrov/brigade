import Link from 'next/link'
import { LegalPage, legalMetadata } from '@/components/landing/legal'
import { OPERATOR } from '@/components/landing/operator'
import { REPO_URL } from '@/lib/github-proof'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = legalMetadata(
  '/terms',
  'Terms of service · Brigade',
  'The rules for using Brigade: your account, your content, your AI teammates and our service.',
)

export default function Terms() {
  return (
    <LegalPage title="Terms of service">
      <p>
        These terms are a contract between you and {OPERATOR.name} (&ldquo;Brigade&rdquo;,
        &ldquo;we&rdquo;), which runs the hosted service at www.brigade.lol. By creating an account
        or using Brigade, you agree to them. If you use Brigade for a company, you agree to them on
        its behalf and confirm you may do so.
      </p>

      <h2>Who Brigade is for</h2>
      <p>
        Brigade is a service for professionals: companies, founders and freelancers using it for
        their work. It is not offered to consumers.
      </p>

      <h2>Your account</h2>
      <p>
        Keep your sign-in safe. You are responsible for what happens in your workspace, including
        what its members and AI teammates do there. Tell us at{' '}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a> if you think someone else got into
        your account.
      </p>

      <h2>Your content</h2>
      <p>
        What you and your teammates put in Brigade stays yours. You give us only the rights we need
        to store it and run the service for you. We process personal data in it on your behalf, as
        our <Link href="/dpa">data processing agreement</Link> says; it is part of these terms. Our{' '}
        <Link href="/privacy">privacy policy</Link> says how we handle your own data.
      </p>

      <h2>AI teammates and your AI subscription</h2>
      <p>
        Teammates act with the access you give them: your Apps, your computers and your
        repositories. They can make mistakes, so check their work before it matters, and only give
        them access you are comfortable with.
      </p>
      <p>
        Teammates run on Claude Code or Codex, signed in with each member&apos;s own Anthropic or
        OpenAI account. Brigade does not sell, resell or pay for that usage. Anthropic&apos;s or
        OpenAI&apos;s terms apply to it, and you must follow them: in particular, each member signs
        in with their own account, and nobody lets another person use theirs. Those providers may
        limit or change what your plan allows; Brigade has no control over that.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don&apos;t use Brigade to break the law, harm others, send spam, mine cryptocurrency, attack
        or scan networks, or get into systems or accounts you aren&apos;t allowed to use. We may
        suspend a workspace that does, and tell you why unless the law or the safety of others
        prevents it.
      </p>

      <h2>Plans and payment</h2>
      <p>
        Brigade is free on your own computer. Brigade Cloud, which gives a workspace its cloud
        computer, is a monthly subscription at the price shown before you subscribe, plus taxes
        where they apply. It is paid in advance through Stripe and renews each month until you
        cancel it. You can cancel at any time in Settings › Billing: it then ends at the end of the
        month already paid, which is not refunded. We announce a price change at least 30 days
        before it applies to you, and you can cancel before then.
      </p>
      <p>
        If a payment fails and is still unpaid after Stripe&apos;s reminders, we may end the
        subscription; the cloud computer then stops, and its data is kept until you delete the
        workspace.
      </p>

      <h2>Ending your use</h2>
      <p>
        You can delete your workspace or your account at any time in Settings. Deleting a workspace
        deletes its threads, files, library, teammates and cloud computer; this cannot be undone. We
        may close an account that breaks these terms, after telling you, or at once for a serious
        breach. When an account or workspace is closed, we delete its data as our privacy policy
        says.
      </p>

      <h2>The software and our service</h2>
      <p>
        Brigade&apos;s code is open source under the{' '}
        <a href={`${REPO_URL}/blob/main/LICENSE`}>MIT license</a>. We work to keep the hosted
        service available and your data safe, but we provide it as is, without warranty of any kind,
        and we may change or stop features.
      </p>
      <p>
        To the extent the law allows, we are not liable for indirect losses (such as lost profits,
        revenue or data) and our total liability is limited to the amounts you paid us in the 12
        months before the claim. Nothing here limits liability for gross negligence, wilful
        misconduct, or anything else the law does not allow us to limit.
      </p>

      <h2>Law and disputes</h2>
      <p>
        These terms are governed by French law. If a dispute cannot be settled between us, the
        courts with jurisdiction for our registered office decide it.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms and change the date at the top when we do. We tell you by email at
        least 30 days before a change that takes rights away from you applies; using Brigade after
        that means you accept it.
      </p>

      <h2>Contact</h2>
      <p>
        {OPERATOR.name}, {OPERATOR.address}. Email{' '}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>, or reach us on{' '}
        <a href={`${REPO_URL}/issues`}>GitHub</a>. Our <Link href="/legal">legal notice</Link> has
        the rest of our details.
      </p>
    </LegalPage>
  )
}
