'use client'
// Under an answer Chief gave in the person's name (docs/chief-answers.md): they mark it wrong, and
// its teammate stops what it started on it and undoes what it can.
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function MarkWrong({ onMark }: { onMark: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void onMark()
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false))
        }}
      >
        Mark as wrong
      </Button>
      <p className="text-xs text-muted-foreground">
        Its teammate stops what it started on it and undoes what it can.
      </p>
      {error && <p className="text-xs text-destructive-text">{error}</p>}
    </div>
  )
}
