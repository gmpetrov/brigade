'use client'
// Brigade.app's screenshot window (apps/desktop/src-tauri/src/capture.rs): each
// capture of the shortcut joins this draft, uploaded at once like a pasted file,
// and the new-thread box sends them with what is written. Closing the window
// keeps it all; the teammate, project and computer stay picked for the next one.
import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { NewThread, useLastTeammate, useThreadDraft } from '@/components/new-thread'
import { newerBuild } from '@/components/update-pill'
import { captures, inCaptureWindow } from '@/lib/brigade-app'

const TEXT = 'brigade.capture.text'
const COMPUTER = 'brigade.capture.computer'

function remembered(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function remember(key: string, value: string | undefined) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {}
}

/** "Screenshot 2026-10-16 at 14.32.05.png", from a capture's name (its time in milliseconds). */
function fileName(capture: string) {
  const at = new Date(Number(capture.replace(/\.png$/, '')))
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
  const time = `${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`
  return `Screenshot ${day} at ${time}.png`
}

function focusMessage() {
  document.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
}

export function CaptureDraft() {
  const { teammates } = useDashboard()
  const [teammateId, chooseTeammate] = useLastTeammate()
  const teammate = teammates.find((t) => t.id === teammateId) ?? teammates[0]
  const draft = useThreadDraft()
  const { files, setText, setComputerId } = draft
  const add = files.add
  const [app] = useState(inCaptureWindow)
  // Each capture added, by the file name it uploaded under; and those taken, read or not yet.
  const added = useRef(new Map<string, string>())
  const taken = useRef(new Set<string>())

  // What was written and where it ran, as left last time.
  useEffect(() => {
    setText(remembered(TEXT) ?? '')
    setComputerId(remembered(COMPUTER))
  }, [setText, setComputerId])

  // The draft's captures, now and as they come.
  useEffect(() => {
    if (!app) return
    async function sync() {
      for (const name of await captures.list()) {
        if (taken.current.has(name)) continue
        taken.current.add(name)
        try {
          const bytes = await captures.read(name)
          const file = new File([bytes], fileName(name), { type: 'image/png' })
          added.current.set(file.name, name)
          add([file])
        } catch {
          taken.current.delete(name)
        }
      }
    }
    void sync()
    const off = [
      captures.onAdded(() => {
        void sync()
        focusMessage()
      }),
      captures.onShown(() => {
        focusMessage()
        // The window stays loaded for as long as Brigade.app runs, with no "New version"
        // pill: shown again after a deploy, it reloads. The text and the captures are kept
        // (localStorage, ~/.brigade/captures), so nothing written is lost.
        void newerBuild().then((newer) => newer && window.location.reload())
      }),
    ]
    return () => off.forEach((o) => void o.then((unlisten) => unlisten()))
  }, [app, add])

  // Esc closes the window, unless a menu or the image preview is open: Esc closes that first.
  useEffect(() => {
    if (!app) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role=dialog]')) return
      void captures.hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [app])

  if (!app)
    return (
      <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        This page is Brigade.app&apos;s screenshot window. On your Mac, press its shortcut (⌘⇧2
        unless changed in Brigade&apos;s menu) to send a screenshot to a teammate.
      </p>
    )
  if (!teammate) return null

  return (
    <div className="flex h-svh flex-col bg-card">
      <NewThread
        layout="dialog"
        fill
        teammate={teammate}
        rows={4}
        autoFocus
        placeholder={`Chat with ${teammate.name}`}
        picker={
          teammates.length > 1 ? { teammates, onChange: chooseTeammate, numbered: true } : undefined
        }
        draft={{
          ...draft,
          setText: (text) => {
            setText(text)
            if (typeof text === 'string') remember(TEXT, text)
          },
          setComputerId: (id) => {
            setComputerId(id)
            if (typeof id === 'string') remember(COMPUTER, id)
          },
          files: {
            ...files,
            // A capture taken off the message leaves the draft too.
            remove: (key: string) => {
              const upload = files.uploads.find((u) => u.key === key)
              const name = upload && added.current.get(upload.name)
              if (name) {
                added.current.delete(upload.name)
                taken.current.delete(name)
                void captures.remove(name)
              }
              files.remove(key)
            },
          },
        }}
        onStarted={() => {
          added.current.clear()
          taken.current.clear()
          remember(TEXT, undefined)
          void captures.clear()
          void captures.hide()
        }}
      />
    </div>
  )
}
