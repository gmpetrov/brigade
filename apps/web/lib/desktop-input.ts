import type RFB from '@novnc/novnc'

/**
 * Keyboard and clipboard between this browser and a Linux desktop over VNC,
 * on top of noVNC's own key handling.
 *
 * - On a Mac, Cmd is Ctrl on the desktop (noVNC alone sends Alt): Cmd+A, Cmd+Z,
 *   Cmd+F... work. Cmd+C sends Ctrl+Insert, which copies in browsers and
 *   terminals alike, where Ctrl+C would interrupt.
 * - Paste (Cmd/Ctrl+V, Shift+Insert) puts this browser's clipboard on the
 *   desktop, then pastes there with Shift+Insert (Ctrl+V does nothing in a
 *   terminal).
 * - Copy (Cmd+C, Cmd+X, Ctrl+C...) brings the desktop's clipboard back here.
 *
 * The clipboard goes through `clipboard`, the API's channel to the computer:
 * VNC's own clipboard is Latin-1 at best, and x11vnc never sends it back.
 * Without that channel, paste uses VNC's for ASCII and types the rest.
 */

export type DesktopClipboard = { set(text: string): Promise<void>; get(): Promise<string> }

const XK = {
  Control_L: 0xffe3,
  Shift_L: 0xffe1,
  Insert: 0xff63,
  Return: 0xff0d,
  Tab: 0xff09,
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Longest text typed key by key when the clipboard cannot carry it. */
const MAX_TYPED = 4000

function keysym(codePoint: number) {
  if (codePoint === 0x0a) return XK.Return
  if (codePoint === 0x09) return XK.Tab
  if (codePoint >= 0x20 && codePoint <= 0xff) return codePoint
  return 0x01000000 | codePoint // X11's Unicode keysyms; x11vnc adds them to the keymap
}

export function bridgeInput(rfb: RFB, container: HTMLElement, clipboard?: DesktopClipboard) {
  const mac = isMac()
  let ctrlDown = false // a Mac's Cmd, held as Ctrl on the desktop
  let lastRemote = ''
  let copyWaiter: ((text: string) => void) | null = null
  let pasteFallback: ReturnType<typeof setTimeout> | undefined

  const live = () => !rfb.viewOnly

  function setCtrl(down: boolean) {
    if (ctrlDown === down) return
    ctrlDown = down
    rfb.sendKey(XK.Control_L, 'ControlLeft', down)
  }

  /** Shift+Insert on the desktop, without the Ctrl a held Cmd puts there. */
  function pasteChord() {
    const held = ctrlDown
    if (held) setCtrl(false)
    rfb.sendKey(XK.Shift_L, 'ShiftLeft', true)
    rfb.sendKey(XK.Insert, 'Insert')
    rfb.sendKey(XK.Shift_L, 'ShiftLeft', false)
    if (held) setCtrl(true)
  }

  function deliver(text: string) {
    if (!text || !live()) return
    text = text.replace(/\r\n?/g, '\n')
    if (clipboard) {
      clipboard.set(text).then(pasteChord, () => deliverOverVnc(text))
      return
    }
    deliverOverVnc(text)
  }

  function deliverOverVnc(text: string) {
    if (/^[\u0000-\u007f]*$/.test(text)) {
      rfb.clipboardPasteFrom(text)
      pasteChord()
      return
    }
    const held = ctrlDown
    if (held) setCtrl(false)
    for (const char of text.slice(0, MAX_TYPED)) rfb.sendKey(keysym(char.codePointAt(0)!), null)
    if (held) setCtrl(true)
  }

  function startPaste() {
    clearTimeout(pasteFallback)
    // The browser fires a paste event next, with the clipboard and no
    // permission prompt. Some browsers don't on a canvas: ask instead.
    pasteFallback = setTimeout(() => {
      pasteFallback = undefined
      navigator.clipboard
        ?.readText()
        .then(deliver)
        .catch(() => undefined)
    }, 100)
  }

  /** The desktop's clipboard once the copy key has reached it. */
  function copied() {
    if (clipboard)
      return new Promise<string>((resolve) => setTimeout(resolve, 300)).then(clipboard.get)
    return new Promise<string>((resolve, reject) => {
      copyWaiter = resolve
      // The same text again sends no update: what the desktop last sent stands.
      setTimeout(() => {
        if (copyWaiter !== resolve) return
        copyWaiter = null
        if (lastRemote) resolve(lastRemote)
        else reject(new Error('nothing copied'))
      }, 700)
    })
  }

  /** Write what the desktop copies here. Starts inside the key event, as Safari requires. */
  function startCopy() {
    const text = copied()
    try {
      void navigator.clipboard
        .write([
          new ClipboardItem({
            'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })),
          }),
        ])
        .catch(() => undefined)
    } catch {
      void text.then((t) => navigator.clipboard.writeText(t)).catch(() => undefined)
    }
  }

  const onClipboard = (e: Event) => {
    lastRemote = (e as CustomEvent<{ text: string }>).detail.text
    const waiter = copyWaiter
    copyWaiter = null
    waiter?.(lastRemote)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!live()) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (mac && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
      e.preventDefault()
      e.stopPropagation()
      setCtrl(true)
      return
    }
    const command = mac ? e.metaKey : e.ctrlKey
    if ((command && key === 'v') || (e.shiftKey && key === 'Insert')) {
      e.stopPropagation() // not to noVNC; the browser goes on to fire paste
      startPaste()
      return
    }
    if (command && (key === 'c' || key === 'x')) startCopy()
    if (mac && e.metaKey && key === 'c' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      rfb.sendKey(XK.Insert, 'Insert')
    }
  }

  const onKeyUp = (e: KeyboardEvent) => {
    if (mac && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
      e.preventDefault()
      e.stopPropagation()
      if (live()) setCtrl(false)
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    if (!live() || !container.contains(document.activeElement)) return
    e.preventDefault()
    clearTimeout(pasteFallback)
    pasteFallback = undefined
    deliver(e.clipboardData?.getData('text/plain') ?? '')
  }

  // Cmd released elsewhere (a Cmd+Tab away) must not stay held on the desktop.
  const onBlur = () => {
    if (live()) setCtrl(false)
    else ctrlDown = false
  }

  container.addEventListener('keydown', onKeyDown, true)
  container.addEventListener('keyup', onKeyUp, true)
  container.addEventListener('focusout', onBlur)
  window.addEventListener('blur', onBlur)
  document.addEventListener('paste', onPaste, true)
  rfb.addEventListener('clipboard', onClipboard)

  return () => {
    clearTimeout(pasteFallback)
    container.removeEventListener('keydown', onKeyDown, true)
    container.removeEventListener('keyup', onKeyUp, true)
    container.removeEventListener('focusout', onBlur)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('paste', onPaste, true)
    rfb.removeEventListener('clipboard', onClipboard)
  }
}
