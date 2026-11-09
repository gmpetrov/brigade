// The document panel folding into the button that brings it back, and growing out of it
// again, so the eye follows where it went (components/document-panel.tsx). Under 300 ms,
// fast at first and slowing as it lands; with reduced motion, a short fade instead.
// Plain Web Animations on the DOM: React only switches the state, before or after.

/** How long the panel takes to land in the button, or to come out of it. */
export const FOLD_MS = 240
/** The button's pop as the panel lands, overlapping the end of the fold. */
const POP_MS = 150
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)'
const FADE_MS = 150

const PANEL = '[data-document-panel]'
const BUTTON = '[data-documents-button]'

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The one of them on screen, if any. */
function visible(selector: string) {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const box = el.getBoundingClientRect()
    if (box.width && box.height && box.bottom > 0 && box.top < window.innerHeight) return el
  }
  return null
}

/** After React has drawn the state just set: two frames on. */
const afterRender = (run: () => void) => requestAnimationFrame(() => requestAnimationFrame(run))

const toward = (from: DOMRect, to: DOMRect) =>
  `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`

/**
 * Call just before the panel is minimized: a still copy of it takes its place and flies into
 * the button once the button shows. Without a panel on screen, nothing.
 */
export function foldIntoButton() {
  const panel = visible(PANEL)
  if (!panel) return
  const from = panel.getBoundingClientRect()
  const ghost = panel.cloneNode(true) as HTMLElement
  // A copy to look at: nothing in it plays, loads, takes focus or makes the page room for it.
  ghost.querySelectorAll('iframe, video, audio, object, embed').forEach((el) => el.remove())
  ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
  for (const name of ['data-document-panel', 'data-desktop-panel', 'id', 'aria-label']) {
    ghost.removeAttribute(name)
  }
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  Object.assign(ghost.style, {
    position: 'fixed',
    inset: 'auto',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    transformOrigin: '0 0',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '60',
  })
  document.body.append(ghost)
  // However it ends, it does not stay.
  const done = () => ghost.remove()
  const fallback = window.setTimeout(done, FOLD_MS + POP_MS + 200)

  afterRender(() => {
    const button = visible(BUTTON)
    if (reduced() || !button) {
      const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: 'ease-out',
      })
      fade.onfinish = done
      return
    }
    const to = button.getBoundingClientRect()
    // What it shows fades first, so the shrinking box reads as the panel, not as squashed text.
    for (const child of ghost.children) {
      child.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FOLD_MS * 0.3,
        fill: 'forwards',
      })
    }
    const fold = ghost.animate(
      [
        { transform: 'none', borderRadius: '0px', opacity: 1 },
        { transform: toward(from, to), borderRadius: '50%', opacity: 0.4 },
      ],
      { duration: FOLD_MS, easing: EASE, fill: 'forwards' },
    )
    window.setTimeout(() => pop(button), FOLD_MS * 0.8)
    fold.onfinish = () => {
      window.clearTimeout(fallback)
      done()
    }
  })
}

/** The button takes the panel in: a short swell. */
function pop(button: HTMLElement) {
  button.animate(
    [
      { transform: 'scale(0.7)' },
      { transform: 'scale(1.08)', offset: 0.6 },
      { transform: 'scale(1)' },
    ],
    { duration: POP_MS, easing: 'ease-out' },
  )
}

/**
 * Call just before the panel is brought back: once it shows, it grows out of the button it
 * was in. Without the button on screen (⌘. with it out of view), it only fades in.
 */
export function unfoldFromButton() {
  const button = visible(BUTTON)
  const from = button?.getBoundingClientRect()
  afterRender(() => {
    const panel = visible(PANEL)
    if (!panel) return
    if (reduced() || !from) {
      panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' })
      return
    }
    const to = panel.getBoundingClientRect()
    panel.animate(
      [
        { transform: toward(to, from), borderRadius: '50%', opacity: 0.4, transformOrigin: '0 0' },
        { transform: 'none', borderRadius: '0px', opacity: 1, transformOrigin: '0 0' },
      ],
      { duration: FOLD_MS, easing: EASE },
    )
    // What it shows comes in once it is mostly there.
    for (const child of panel.children) {
      child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], {
        duration: FOLD_MS,
      })
    }
  })
}
