import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function Landing() {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
        <span
          aria-hidden
          className="flex size-14 items-center justify-center rounded-2xl bg-primary text-2xl font-extrabold text-primary-foreground"
        >
          B
        </span>
        <h1 className="text-4xl font-extrabold tracking-tight">Brigade</h1>
        <p className="text-lg">
          One place to direct AI teammates across support, sales, marketing and engineering, and to
          see and approve what they do.
        </p>
        <p className="text-muted-foreground">
          Bring your own Claude subscription. Teammates run on a computer you control, every step is
          logged, and risky steps wait for your yes.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up">Get started</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
