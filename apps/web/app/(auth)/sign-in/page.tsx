'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authClient } from '@/lib/auth-client'

export default function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(form: FormData) {
    setBusy(true)
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setBusy(false)
    if (error) return setError(error.message ?? 'Could not sign in')
    router.push('/app')
  }

  return (
    <main className="narrow">
      <h1>Sign in to Brigade</h1>
      <form action={submit} className="card">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
      <p className="hint" style={{ marginTop: 12 }}>
        New here? <Link href="/sign-up">Create an account</Link>
      </p>
    </main>
  )
}
