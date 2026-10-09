import Link from 'next/link'

export default function Landing() {
  return (
    <main className="narrow" style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 32 }}>Brigade</h1>
      <p style={{ fontSize: 17 }}>
        One place to direct AI teammates across support, sales, marketing and engineering, and to
        see and approve what they do.
      </p>
      <p className="hint">
        Bring your own Claude subscription. Teammates run on a computer you control, every step is
        logged, and risky steps wait for your yes.
      </p>
      <div className="row" style={{ marginTop: 24 }}>
        <Link className="button primary" href="/sign-up">
          Get started
        </Link>
        <Link className="button" href="/sign-in">
          Sign in
        </Link>
      </div>
    </main>
  )
}
