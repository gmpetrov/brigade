// The demo's walkthrough, played on its own in the landing page's frame (demo.brigade.lol/app?tour):
// a cursor named Ada uses the real dashboard, the way squad.so and x.ai/bot show theirs. She
// asks Riley to fix the export button, merges his pull request, lets the replies to the
// customers go, and makes it a routine; the teammate's side is scripted in lib/demo/scripts.ts.
// It acts through the page's own elements, with events no person made: the first one a person
// makes (a click, a key, the wheel) stops it, and the dashboard is theirs.

export const TOUR_PARAM = 'tour'

/** The message Ada sends, and the one that makes it a routine: scripts.ts answers both. */
export const TOUR_ASK =
  'A customer says the export button on Reports does nothing. Fix it and tell the customers who asked.'
export const TOUR_ROUTINE = 'Great. Do the same for every bug report that comes in.'

export class Stopped extends Error {}

/** What a tour step needs: where the cursor is drawn, and whether to go on. */
export type Stage = {
  signal: AbortSignal
  cursor: HTMLElement
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped())
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Stopped())
    })
  })

const visible = (el: Element) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** Waits for what `find` returns, as the page loads or a teammate's run gets there. */
export async function waitFor<T>(
  find: () => T | null | undefined,
  signal: AbortSignal,
  timeout = 45_000,
): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() > end) throw new Stopped()
    await sleep(120, signal)
  }
}

/** The last visible element matching `selector` whose text has `text`. */
export function byText(selector: string, text: string | RegExp) {
  const all = [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (el) =>
      visible(el) &&
      (typeof text === 'string' ? el.textContent?.includes(text) : text.test(el.textContent ?? '')),
  )
  return all.at(-1)
}

/** The last visible element matching `selector`. */
export function last(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(visible).at(-1)
}

const center = (el: Element) => {
  const r = el.getBoundingClientRect()
  return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 }
}

/** Glides the cursor to the element, scrolling it into view first. */
export async function moveTo(stage: Stage, el: HTMLElement) {
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  await sleep(250, stage.signal)
  const { x, y } = center(el)
  stage.cursor.style.transform = `translate(${x}px, ${y}px)`
  await sleep(750, stage.signal)
}

/** A press as a mouse makes it: what menus listen for (pointerdown) and what buttons do (click). */
export async function press(stage: Stage, el: HTMLElement) {
  await moveTo(stage, el)
  const { x, y } = center(el)
  const at = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
  stage.cursor.dataset.pressed = ''
  el.dispatchEvent(
    new PointerEvent('pointerdown', { ...at, buttons: 1, pointerType: 'mouse', isPrimary: true }),
  )
  el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }))
  await sleep(120, stage.signal)
  el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mouseup', at))
  el.click()
  delete stage.cursor.dataset.pressed
  await sleep(350, stage.signal)
}

/** Types into the message box as a person would, a letter at a time. */
export async function type(stage: Stage, editor: HTMLElement, text: string) {
  await press(stage, editor)
  editor.focus()
  // A word at a time: the box drops letters typed faster than it renders them.
  for (const word of text.split(/(?<= )/)) {
    document.execCommand('insertText', false, word)
    await sleep(70 + word.length * 14, stage.signal)
  }
  await sleep(500, stage.signal)
}

/** Enter in the message box: it sends. */
export async function send(stage: Stage, editor: HTMLElement) {
  for (const kind of ['keydown', 'keyup'] as const)
    editor.dispatchEvent(
      new KeyboardEvent(kind, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    )
  await sleep(300, stage.signal)
}

const EDITOR = '[contenteditable="true"]'

/** The walkthrough itself. Resolves once Ada is done; throws Stopped when a person takes over. */
export async function play(stage: Stage) {
  const { signal } = stage
  // Home: the message box, and who it goes to.
  const picker = await waitFor(() => last('button[aria-label$="Change teammate"]'), signal)
  await waitFor(() => last(EDITOR), signal)
  stage.cursor.hidden = false
  await sleep(900, signal)

  await press(stage, picker)
  const riley = await waitFor(() => byText('[role="menuitem"]', 'Riley'), signal)
  await press(stage, riley)
  const box = await waitFor(() => last(EDITOR), signal)
  await type(stage, box, TOUR_ASK)
  await send(stage, box)

  // The thread: Riley fixes it and offers the merge.
  await waitFor(() => location.pathname.startsWith('/app/threads/'), signal)
  const merge = await waitFor(() => byText('button', 'Merge #153'), signal, 60_000)
  await sleep(1400, signal)
  await press(stage, merge)

  // Once merged, the replies to the customers wait for Ada's OK.
  const allow = await waitFor(() => byText('button', /^Allow$/), signal, 60_000)
  await sleep(1600, signal)
  await press(stage, allow)

  // Sent: then make it a routine.
  await waitFor(() => byText('p', 'Sent to the 3 customers'), signal, 30_000)
  await sleep(1500, signal)
  const reply = await waitFor(() => last(EDITOR), signal)
  await type(stage, reply, TOUR_ROUTINE)
  await send(stage, reply)
  await waitFor(() => byText('p', 'Morning bug reports'), signal, 30_000)
  await sleep(1200, signal)
}
