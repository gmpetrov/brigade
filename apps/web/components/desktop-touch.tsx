'use client'
// On a phone or a tablet, what a mouse and keyboard do elsewhere on the computer's
// screen: an on-screen keyboard whose keys go to the desktop, and copy and paste
// between this device and the desktop through a menu (there are no Cmd+C, Cmd+V keys).
import { Clipboard, ClipboardPaste, Copy, Keyboard } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { XK, type DesktopInput } from '@/lib/desktop-input'

/** A touch screen is the main pointer: a phone or a tablet. */
export function useTouchScreen() {
  const [touch, setTouch] = useState(false)
  useEffect(() => setTouch(window.matchMedia('(pointer: coarse)').matches), [])
  return touch
}

/**
 * What the field holds while nothing is typed: the keyboard's Backspace needs
 * something to delete, and each change to it is what goes to the desktop.
 */
const FILLER = '_'.repeat(64)

const KEYS: Record<string, number> = {
  Escape: XK.Escape,
  Tab: XK.Tab,
  ArrowLeft: XK.Left,
  ArrowUp: XK.Up,
  ArrowRight: XK.Right,
  ArrowDown: XK.Down,
}

/**
 * A field out of sight that brings up the on-screen keyboard as it takes focus.
 * What is typed in it, autocorrect and accents included, goes to the desktop as
 * keys: the difference from what it held, as Backspaces and characters.
 */
export function KeyboardField({
  input,
  fieldRef,
  onOpen,
}: {
  input?: DesktopInput
  fieldRef: RefObject<HTMLTextAreaElement | null>
  onOpen: (open: boolean) => void
}) {
  const held = useRef(FILLER)
  const composing = useRef(false)

  function reset(field: HTMLTextAreaElement) {
    field.value = FILLER
    held.current = FILLER
    field.setSelectionRange(FILLER.length, FILLER.length)
  }

  function send(field: HTMLTextAreaElement) {
    const before = [...held.current]
    const now = [...field.value]
    let same = 0
    while (same < before.length && same < now.length && before[same] === now[same]) same++
    for (let i = same; i < before.length; i++) input?.key(XK.BackSpace)
    input?.type(now.slice(same).join(''))
    held.current = field.value
    if (now.length < 16 || now.length > 512) reset(field)
  }

  return (
    <textarea
      ref={fieldRef}
      aria-label="Type on the computer"
      defaultValue={FILLER}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      // Its keys go to the remote desktop, Escape included: no panel closes on it.
      data-keyboard
      // At the top, where the keyboard never covers it: iOS scrolls nothing into view.
      // 16px, or iOS zooms in on it.
      className="pointer-events-none absolute top-0 left-0 size-px resize-none overflow-hidden border-0 p-0 text-base opacity-0"
      onFocus={(e) => {
        reset(e.currentTarget)
        onOpen(true)
      }}
      onBlur={() => onOpen(false)}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false
        send(e.currentTarget)
      }}
      onInput={(e) => {
        if (!composing.current) send(e.currentTarget)
      }}
      onKeyDown={(e) => {
        const key = KEYS[e.key]
        if (!key || e.nativeEvent.isComposing) return
        e.preventDefault()
        input?.key(key)
      }}
    />
  )
}

/** The toolbar's keyboard button and copy and paste menu, with control on a touch screen. */
export function TouchButtons({
  input,
  keyboardOpen,
  onKeyboard,
}: {
  input?: DesktopInput
  keyboardOpen: boolean
  /** Show the keyboard (focus the field, inside the tap, as iOS requires) or hide it. */
  onKeyboard: () => void
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!input}
            aria-label="Copy and paste"
            title="Copy and paste"
          >
            <Clipboard aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" className="z-[60]">
          <DropdownMenuItem
            onSelect={() => {
              // Inside the tap: iOS asks to paste, no permission needed.
              void navigator.clipboard
                ?.readText()
                .then((text) => input?.paste(text))
                .catch(() => undefined)
            }}
          >
            <ClipboardPaste aria-hidden />
            Paste from phone
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => input?.copy()}>
            <Copy aria-hidden />
            Copy to phone
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!input}
        aria-pressed={keyboardOpen}
        className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
        // Keep the field's focus: a tap on the button would blur it before the click.
        onPointerDown={(e) => e.preventDefault()}
        onClick={onKeyboard}
        aria-label={keyboardOpen ? 'Hide the keyboard' : 'Keyboard'}
        title={keyboardOpen ? 'Hide the keyboard' : 'Keyboard'}
      >
        <Keyboard aria-hidden />
      </Button>
    </>
  )
}

/**
 * While the on-screen keyboard is up, how much of `ref` it and a panned page hide,
 * at its foot and top: the screen and its toolbar stay in what is left.
 */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>, open: boolean) {
  const [inset, setInset] = useState({ top: 0, bottom: 0 })
  useEffect(() => {
    const viewport = window.visualViewport
    if (!open || !viewport) {
      setInset({ top: 0, bottom: 0 })
      return
    }
    const update = () => {
      const box = ref.current?.getBoundingClientRect()
      if (!box) return
      const top = Math.max(0, viewport.offsetTop - box.top)
      const bottom = Math.max(0, box.bottom - (viewport.offsetTop + viewport.height))
      setInset((was) => (was.top === top && was.bottom === bottom ? was : { top, bottom }))
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [ref, open])
  return inset
}
