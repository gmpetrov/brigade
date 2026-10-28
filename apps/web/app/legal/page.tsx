import { notFound } from 'next/navigation'
import { LegalPage, legalMetadata } from '@/components/landing/legal'
import { OPERATOR } from '@/components/landing/operator'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = legalMetadata(
  '/legal',
  'Legal notice · Brigade',
  'Who publishes www.brigade.lol, and who hosts it.',
)

/** The mentions légales French law asks every site to show. */
export default function LegalNotice() {
  const company = OPERATOR.company
  // Published once the company exists (operator.ts).
  if (!company) notFound()
  return (
    <LegalPage title="Legal notice">
      <h2>Publisher</h2>
      <p>
        {company.name}, share capital {company.capital}, {company.registration}, VAT {company.vat}.
        Registered office: {company.address}. Email:{' '}
        <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>.
      </p>
      <p>Publication director: {company.director}.</p>

      <h2>Host</h2>
      <p>
        Cloudflare, Inc., 101 Townsend Street, San Francisco, CA 94107, United States,{' '}
        <a href="https://www.cloudflare.com">www.cloudflare.com</a>.
      </p>
    </LegalPage>
  )
}
