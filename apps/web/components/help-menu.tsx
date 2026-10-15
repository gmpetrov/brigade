'use client'
// The keyboard shortcuts: from the member's menu in the sidebar footer (openShortcuts),
// or ⇧? anywhere outside a field.
import { Fragment, useEffect, useState } from 'react'
import { useIsMac } from '@/lib/platform'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Focus is in a field: ? there is text, not a shortcut. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** `mod` is ⌘ on a Mac, Ctrl elsewhere; each entry is one way to press it. */
const SHORTCUTS: { title: string; items: { label: string; keys: string[][] }[] }[] = [
  {
    title: 'General',
    items: [
      { label: 'Search', keys: [['mod', 'K']] },
      { label: 'New thread', keys: [['mod', 'shift', 'K']] },
      { label: 'Show or hide threads', keys: [['mod', 'J']] },
      { label: 'Toggle the sidebar', keys: [['mod', 'B']] },
      { label: 'Keyboard shortcuts', keys: [['shift', '?']] },
      { label: 'Close a dialog', keys: [['Esc']] },
    ],
  },
  {
    title: 'Writing a message',
    items: [
      { label: 'Send, or queue while the teammate works', keys: [['Enter']] },
      { label: 'New line', keys: [['shift', 'Enter']] },
      { label: 'Mention a teammate, repository, file…', keys: [['@']] },
      { label: 'Commands', keys: [['/']] },
    ],
  },
]

function Keys({ keys, mac }: { keys: string[]; mac: boolean }) {
  const names: Record<string, string> = mac
    ? { mod: '⌘', shift: '⇧', Enter: '↵' }
    : { mod: 'Ctrl', shift: 'Shift', Enter: 'Enter' }
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="flex h-6 min-w-6 items-center justify-center rounded-md border bg-muted px-1.5 font-sans text-xs font-medium text-muted-foreground"
        >
          {names[k] ?? k}
        </kbd>
      ))}
    </span>
  )
}

const OPEN_EVENT = 'brigade:shortcuts'

/** Opens the shortcuts from a menu. */
export function openShortcuts() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function ShortcutsDialog() {
  const mac = useIsMac()
  const [shortcuts, setShortcuts] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat || e.key !== '?' || !e.shiftKey || e.metaKey || e.ctrlKey)
        return
      if (typing(e.target) || document.querySelector('[role=dialog][data-state=open]')) return
      e.preventDefault()
      setShortcuts(true)
    }
    const onOpen = () => setShortcuts(true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  return (
    <>
      <Dialog open={shortcuts} onOpenChange={setShortcuts}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              {mac ? '⇧?' : 'Shift+?'} works when you are not typing in a field.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5">
            {SHORTCUTS.map((group) => (
              <section key={group.title} className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  {group.title}
                </h3>
                <ul className="divide-y">
                  {group.items.map((item) => (
                    <li
                      key={item.label}
                      className="flex items-center justify-between gap-4 py-2 text-sm"
                    >
                      <span>{item.label}</span>
                      <span className="flex items-center gap-2">
                        {item.keys.map((keys, i) => (
                          <Fragment key={keys.join('+')}>
                            {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
                            <Keys keys={keys} mac={mac} />
                          </Fragment>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
