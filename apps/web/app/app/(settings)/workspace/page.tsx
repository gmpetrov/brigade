'use client'
// Workspace: its name and logo, seen by every member in the sidebar and the
// workspace menu. Owners and admins change them; the others see them here.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isAdmin, useDashboard, WorkspaceMark } from '@/components/dashboard'
import { shrinkLogo } from '@/components/projects'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

export default function WorkspacePage() {
  const { me, reloadMe } = useDashboard()
  const admin = isAdmin(me)
  const workspace = me.workspaces.find((w) => w.id === me.activeWorkspaceId)
  const [name, setName] = useState(workspace?.name ?? '')
  /** Unset: as it is. Null: back to the letter. A data URL: a new logo. */
  const [logo, setLogo] = useState<string | null>()
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()

  const changed = name.trim() !== (workspace?.name ?? '') || logo !== undefined
  // A change made elsewhere shows unless this form has unsaved edits.
  useEffect(() => {
    if (!changed) setName(workspace?.name ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the workspace changes
  }, [workspace?.name])

  if (!workspace) return null

  function pickLogo(picked: File | undefined) {
    if (!picked) return
    const reader = new FileReader()
    reader.onload = async () => {
      const shrunk = await shrinkLogo(String(reader.result)).catch(() => null)
      if (!shrunk) return setError('That image cannot be a logo: try a PNG or an SVG under 256 KB')
      setLogo(shrunk)
      setSaved(false)
      setError(undefined)
    }
    reader.readAsDataURL(picked)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Name the workspace')
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      await api('/workspace', {
        method: 'PATCH',
        body: { name: name.trim(), ...(logo !== undefined && { logo }) },
      })
      await reloadMe()
      setLogo(undefined)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** What shows now: the new logo, the letter, or the saved one. */
  const hasLogo = logo === undefined ? Boolean(workspace.logo) : logo !== null

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Workspace</h1>
        <p className="max-w-prose text-muted-foreground">
          Its name and logo, seen by every member in the sidebar.{' '}
          {!admin && 'Owners and admins can change them.'}
        </p>
      </header>

      <form onSubmit={(e) => void save(e)}>
        <Card className="gap-5 px-6 py-5">
          <div className="flex flex-col gap-2">
            <Label>Logo</Label>
            <div className="flex flex-wrap items-center gap-3">
              {logo ? (
                <span aria-hidden className="flex size-12 overflow-hidden rounded-md">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, not sent yet */}
                  <img src={logo} alt="" className="size-full object-cover" />
                </span>
              ) : (
                <WorkspaceMark
                  workspace={logo === null ? { ...workspace, logo: null } : workspace}
                  className="size-12 rounded-md bg-primary text-xl text-primary-foreground"
                />
              )}
              {admin && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => file.current?.click()}
                  >
                    Upload
                  </Button>
                  {hasLogo && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLogo(null)
                        setSaved(false)
                      }}
                    >
                      Remove
                    </Button>
                  )}
                  <input
                    ref={file}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      pickLogo(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </>
              )}
              {!hasLogo && (
                <span className="text-sm text-muted-foreground">None: its first letter shows.</span>
              )}
            </div>
          </div>
          <div className="flex max-w-sm flex-col gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setSaved(false)
              }}
              maxLength={80}
              disabled={!admin}
            />
          </div>
          {admin && (
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={busy || !changed}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              {saved && !changed && <span className="text-sm text-muted-foreground">Saved</span>}
              {error && <span className="text-sm text-destructive-text">{error}</span>}
            </div>
          )}
        </Card>
      </form>
    </div>
  )
}
