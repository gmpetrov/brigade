import Link from 'next/link'
import { LegalPage, legalMetadata } from '@/components/landing/legal'
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
        By creating an account or using Brigade, you agree to these terms. If you use Brigade for a
        company, you agree to them on its behalf.
      </p>

      <h2>Your account</h2>
      <p>
        Keep your sign-in safe; you are responsible for what happens in your workspace, including
        what its members and AI teammates do there.
      </p>

      <h2>Your content</h2>
      <p>
        What you and your teammates put in Brigade stays yours. You give us only the rights we need
        to store it and run the service for you. Our <Link href="/privacy">privacy policy</Link>{' '}
        says how we handle it.
      </p>

      <h2>AI teammates</h2>
      <p>
        Teammates act with the access you give them: your Apps, your computers and your
        repositories. They can make mistakes, so check their work before it matters, and only give
        them access you are comfortable with. They run on your own Claude or Codex subscription,
        whose terms also apply.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don&apos;t use Brigade to break the law, harm others, send spam, or get into systems or
        accounts you aren&apos;t allowed to use. We may suspend accounts that do.
      </p>

      <h2>Plans</h2>
      <p>
        Brigade is free on your own Mac. The cloud computer is a paid plan; its price is shown
        before you subscribe, and you can cancel at any time.
      </p>

      <h2>The software</h2>
      <p>
        Brigade&apos;s code is open source under the{' '}
        <a href={`${REPO_URL}/blob/main/LICENSE`}>MIT license</a>. The hosted service is provided as
        is, without warranty, and to the extent the law allows we aren&apos;t liable for indirect
        losses from using it.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; we change the date at the top when we do. Using Brigade after
        that means you accept them. Questions: reach us on <a href={`${REPO_URL}/issues`}>GitHub</a>
        .
      </p>
    </LegalPage>
  )
}
