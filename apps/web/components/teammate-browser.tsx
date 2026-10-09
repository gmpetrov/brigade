'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { openDesktop, type Computer, type Teammate } from '@/lib/api'

/**
 * The teammate's own browser on the workspace computer. A person signs it in
 * to sites here, through the computer's desktop; the sign-in stays in the
 * teammate's profile for all its threads.
 */
export function TeammateBrowser({
  teammate,
  computer,
}: {
  teammate: Teammate
  computer: Computer | undefined
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function open(e: React.FormEvent) {
    e.preventDefault()
    if (!computer) return
    setBusy(true)
    setError(undefined)
    try {
      await openDesktop(computer.id, {
        teammateId: teammate.id,
        ...(url.trim() ? { url: url.trim() } : {}),
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-bold">Browser</h2>
        </CardTitle>
        {computer ? (
          <CardDescription className="leading-relaxed">
            {teammate.name} has its own browser on the workspace computer, shared by all its
            threads. To sign it in to a site, open it here, sign in on the desktop (including any
            second factor) and close the tab. The sign-in stays in {teammate.name}&apos;s profile
            only. Where Brigade has a connector for a service, grant that instead.
          </CardDescription>
        ) : (
          <CardDescription className="leading-relaxed">
            Teammate browsers live on the workspace computer. On your own machine, {teammate.name}{' '}
            uses your browser and the sign-ins already in it.
          </CardDescription>
        )}
      </CardHeader>
      {computer && (
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={(e) => void open(e)} className="flex flex-wrap gap-2.5">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Site to sign in to"
              placeholder="https://site-to-sign-in-to.example (optional)"
              className="w-auto flex-[1_1_16rem]"
            />
            <Button type="submit" disabled={busy}>
              {busy ? 'Opening…' : `Open ${teammate.name}'s browser`}
            </Button>
          </form>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
        </CardContent>
      )}
    </Card>
  )
}
