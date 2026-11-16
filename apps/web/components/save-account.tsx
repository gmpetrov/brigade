'use client'
import { ArrowRight } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Hint } from '@/components/ui/tooltip'
import { saveAccount, sendSavingCode } from '@/lib/guest'

/**
 * A guest (docs/guests.md) saves their account: an email, then the code mailed to it. From then
 * on they sign in with it, anywhere, and what waited for it opens (inviting people, Brigade
 * Cloud). `leaving`: they asked to sign out, which a guest cannot come back from.
 */
export function SaveAccountDialog({
  open,
  onOpenChange,
  onSaved,
  leaving,
  onLeave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  leaving?: boolean
  onLeave?: () => void
}) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run(event: FormEvent, step: () => Promise<void>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await step()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSent(false)
          setCode('')
          setError(undefined)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{leaving ? 'Save your account first?' : 'Save your account'}</DialogTitle>
          <DialogDescription>
            {leaving
              ? 'You started without an account: signed out, you could not come back to this project. Save it with your email to sign in again later.'
              : 'Add your email to keep your project, sign in on your other devices and invite people.'}
          </DialogDescription>
        </DialogHeader>
        {!sent ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) =>
              void run(e, async () => {
                await sendSavingCode(email)
                setSent(true)
              })
            }
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="save-email">Email</Label>
              <Input
                id="save-email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive-text">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send me a code'}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) =>
              void run(e, async () => {
                await saveAccount(email, code)
                onSaved()
                onOpenChange(false)
              })
            }
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="save-code">The code we sent to {email}</Label>
              <Input
                id="save-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            {error && <p className="text-sm text-destructive-text">{error}</p>}
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Saving…' : 'Save my account'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setSent(false)
                setCode('')
                setError(undefined)
              }}
              className="self-center text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Use another email
            </button>
          </form>
        )}
        {leaving && onLeave && (
          <button
            type="button"
            onClick={onLeave}
            className="self-center text-sm text-destructive-text underline-offset-4 hover:underline"
          >
            Sign out and lose this project
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A guest's reminder at the foot of the sidebar; folded to icons, a round button. */
export function GuestBanner({ onSave }: { onSave: () => void }) {
  return (
    <div className="mx-2 group-data-[collapsible=icon]:mx-0">
      <div className="bg-card rounded-lg border p-3 text-sm group-data-[collapsible=icon]:hidden">
        <p className="font-semibold">No account yet</p>
        <p className="text-muted-foreground mt-1 text-[0.8125rem] leading-snug">
          Save it with your email to keep this project and use Brigade on your phone.
        </p>
        <Button size="sm" className="mt-2.5 w-full rounded-full" onClick={onSave}>
          Save my account
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      </div>
      <Hint side="right" label="Save your account">
        <button
          type="button"
          onClick={onSave}
          aria-label="Save your account"
          className="bg-primary text-primary-foreground hidden size-8 items-center justify-center rounded-full group-data-[collapsible=icon]:flex"
        >
          <ArrowRight className="size-4" aria-hidden />
        </button>
      </Hint>
    </div>
  )
}
