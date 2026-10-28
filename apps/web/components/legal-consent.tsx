import Link from 'next/link'

const link = 'underline underline-offset-4 hover:text-foreground'

/** Under a sign-in or sign-up form: signing in with a code or Google can also create the account. */
export function LegalConsent() {
  return (
    <p className="text-center text-xs text-muted-foreground">
      By continuing, you agree to Brigade&apos;s{' '}
      <Link href="/terms" target="_blank" className={link}>
        Terms of service
      </Link>{' '}
      and{' '}
      <Link href="/dpa" target="_blank" className={link}>
        Data processing agreement
      </Link>
      , and acknowledge its{' '}
      <Link href="/privacy" target="_blank" className={link}>
        Privacy policy
      </Link>
      .
    </p>
  )
}
