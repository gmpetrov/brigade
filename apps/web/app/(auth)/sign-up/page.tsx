'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { EmailSignIn } from '@/components/email-sign-in'
import { GoogleSignIn } from '@/components/google-sign-in'
import { AuthLink } from '@/components/landing/auth-link'
import { LegalConsent } from '@/components/legal-consent'
import { Card, CardContent } from '@/components/ui/card'
import { markSignedIn } from '@/lib/signed-in'

export default function SignUp() {
  const router = useRouter()
  const [error, setError] = useState<string>()

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrigadeMark className="size-14" />
          <h1 className="text-3xl font-extrabold tracking-tight">Create your account</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-5">
            <GoogleSignIn onError={setError} />
            {error && <p className="text-sm text-destructive-text">{error}</p>}
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <EmailSignIn
              withName
              submitLabel="Create account"
              onSignedIn={() => {
                markSignedIn()
                router.push('/onboarding')
              }}
            />
            <LegalConsent />
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <AuthLink
            passOn
            href="/sign-in"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </AuthLink>
        </p>
      </div>
    </main>
  )
}
