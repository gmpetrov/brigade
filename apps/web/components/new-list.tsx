'use client'
import { newListPath, newListText, type LibraryFile } from '@brigade/contracts'
import { Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiError, isViewer } from '@/lib/api'

/**
 * A new list (docs/lists.md): a Markdown file of the library named after it, in a project's
 * folder or at the library's root, opened on its list page to write its lines.
 */
export function NewList({
  folder,
  variant = 'default',
  size = 'default',
  label = 'New list',
}: {
  /** The project's folder it is made from; none: the library's root. */
  folder?: string | null
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'default' | 'sm'
  label?: string
}) {
  const router = useRouter()
  const { me } = useDashboard()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (isViewer(me)) return null

  const path = newListPath(name, folder)

  function show(next: boolean) {
    setOpen(next)
    if (next) {
      setName('')
      setError(undefined)
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const file = await api<LibraryFile>('/library/text', {
        body: { path, text: newListText(name) },
      })
      setOpen(false)
      router.push(`/app/lists/${file.id}`)
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? `${path} is in the library already. Pick another name.`
          : (e as Error).message,
      )
    }
    setBusy(false)
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => show(true)}>
        <Plus />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={show}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New list</DialogTitle>
            <DialogDescription>
              A checklist whose lines you hand to teammates, saved in the library.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={create}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-list-name">Name</Label>
              <Input
                id="new-list-name"
                autoFocus
                autoComplete="off"
                required
                maxLength={120}
                placeholder="Launch plan"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {name.trim() && (
              <p className="-mt-1 truncate text-xs text-muted-foreground">
                Saved as <span className="font-mono text-foreground">{path}</span>
              </p>
            )}
            {error && <p className="text-sm text-destructive-text">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => show(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
