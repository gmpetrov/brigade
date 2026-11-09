// The demo's walkthroughs, played on their own in the landing page's frame
// (demo.brigade.lol/app?tour=<story>, the landing page's picker chooses): a cursor marked "You"
// (the visitor, as Ada, the workspace's owner) uses the real dashboard. It asks a teammate for
// a job, then approves what waits for it (a merge, an email) until the job is done; the
// teammate's side is scripted in lib/demo/scripts.ts.
// It acts through the page's own elements, with events no person made: the first one a person
// makes (a click, a key, the wheel) stops it, and the dashboard is theirs.

export const TOUR_PARAM = 'tour'

/** The message the cursor sends, and the one that makes it a routine: scripts.ts answers both. */
export const TOUR_ASK =
  'A customer says the export button on Reports does nothing. Fix it and tell the customers who asked.'
export const TOUR_ROUTINE = 'Great. Do the same for every bug report that comes in.'

/** The line the `list` walkthrough adds to Acme's launch checklist, then hands to Riley. */
export const LIST_LINE = 'Add a changelog page linked from the footer'
/** That list, as its title shows in Lists and on a thread's Working on card. */
export const LIST_TITLE = 'Launch checklist'

/** Each walkthrough: whom the cursor asks, what, the buttons it presses in turn, and the words
 * in the teammate's last reply that say it's done. */
export const STORIES = {
  bug: {
    teammate: 'Riley',
    ask: TOUR_ASK,
    presses: ['Merge #153', 'Allow'],
    done: 'Sent to the 3 customers',
  },
  feature: {
    teammate: 'Riley',
    ask: 'Jo at Northwind asked for CSV export on Invoices. Ship it, record a short demo and send it to Jo.',
    presses: ['Merge #154', 'Allow'],
    done: 'CSV export is live',
  },
  call: {
    teammate: 'Sam',
    ask: 'Prep me for tomorrow’s call with Northwind.',
    presses: ['Allow'],
    done: 'Agenda for tomorrow',
  },
  payment: {
    teammate: 'Sam',
    ask: 'Globex’s payment failed in Stripe. Sort it out.',
    presses: ['Allow'],
    done: 'Your card expired',
  },
  // Not asked in Home: the cursor adds `ask` to the launch checklist and hands it to the teammate
  // (playList), then merges its pull request, which ticks the line.
  list: {
    teammate: 'Riley',
    ask: LIST_LINE,
    presses: ['Merge #155'],
    done: `is ticked on ${LIST_TITLE}`,
    list: LIST_TITLE,
  },
} as const
export type Story = keyof typeof STORIES
export const storyOf = (value: string | null): Story =>
  value && value in STORIES ? (value as Story) : 'bug'

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
export async function press(
  stage: Stage,
  target: HTMLElement | (() => HTMLElement | null | undefined),
) {
  const find = typeof target === 'function' ? target : () => target
  await moveTo(stage, await waitFor(find, stage.signal))
  // Found again once there: what the page drew again meanwhile (a line's chips) is pressed.
  const el = await waitFor(find, stage.signal)
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
  // An editor may draw what was pressed again on mousedown (a line's chips): the click goes to
  // what is there now.
  const now = el.isConnected ? el : find()
  ;(now ?? el).click()
  delete stage.cursor.dataset.pressed
  await sleep(350, stage.signal)
}

/**
 * Types into the message box as a person would, a letter at a time. `where: 'caret'` types where
 * the caret is already, in a document: a press on the editor would move it there.
 */
export async function type(
  stage: Stage,
  editor: HTMLElement,
  text: string,
  where: 'press' | 'caret' = 'press',
) {
  if (where === 'press') await press(stage, editor)
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

/** A key pressed in the element, as a keyboard makes it: what editors listen for. */
async function key(stage: Stage, el: HTMLElement, name: string, shift = false) {
  for (const kind of ['keydown', 'keyup'] as const)
    el.dispatchEvent(
      new KeyboardEvent(kind, {
        key: name,
        code: name,
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    )
  await sleep(200, stage.signal)
}

/** The text of a line of a document, which the editor's selection is set in. */
const lineText = (line: HTMLElement) =>
  line.querySelector<HTMLElement>('.bn-inline-content') ?? line

/** The caret at the end of the line, as a click there puts it: the editor reads the page's selection. */
async function caretAtEnd(stage: Stage, editor: HTMLElement, line: HTMLElement) {
  await press(stage, lineText(line))
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(lineText(line))
  range.collapse(false)
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  await sleep(300, stage.signal)
}

/** The line's text selected, as a drag over it does: its toolbar shows (Hand to…). */
async function selectLine(stage: Stage, editor: HTMLElement, line: HTMLElement) {
  await moveTo(stage, lineText(line))
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(lineText(line))
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  await sleep(600, stage.signal)
}

/** A line of the list on the page, by its text. */
const listLine = (text: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '.bn-block-content[data-content-type="checkListItem"]',
    ),
  ]
    .filter(visible)
    .find((el) => el.textContent?.includes(text))

/** The link to the list: the sidebar's row, a row of Lists, or the thread's Working on card. */
const listLink = (title: string) => byText('a[href^="/app/lists/"]', title)

/**
 * The `list` walkthrough (docs/demo.md): in Lists, the cursor adds a line to the launch checklist
 * and hands it to Riley; the line shows Riley's thread, then the pull request; the cursor merges
 * it from the thread, and back in the list the line is ticked, under Recently done too.
 */
async function playList(stage: Stage, story: (typeof STORIES)['list']) {
  const { signal } = stage
  // Lists, then the launch checklist.
  const lists = await waitFor(() => last('a[href="/app/lists"]'), signal)
  stage.cursor.hidden = false
  await sleep(900, signal)
  await press(stage, lists)
  await press(stage, await waitFor(() => listLink(story.list), signal))

  // A line at its end.
  const editor = await waitFor(() => last(`.list-view ${EDITOR}`), signal)
  const end = await waitFor(() => {
    const lines = [
      ...editor.querySelectorAll<HTMLElement>(
        '.bn-block-content[data-content-type="checkListItem"]',
      ),
    ]
    return lines.at(-1)
  }, signal)
  await sleep(600, signal)
  await caretAtEnd(stage, editor, end)
  await key(stage, editor, 'Enter')
  await type(stage, editor, story.ask, 'caret')
  const added = await waitFor(() => listLine(story.ask), signal)

  // Handed to Riley.
  await selectLine(stage, editor, added)
  await press(stage, await waitFor(() => byText('button', /^Hand to /), signal))
  const picker = await waitFor(() => last('#hand-off-teammate'), signal)
  await sleep(500, signal)
  await press(stage, picker)
  await press(stage, await waitFor(() => byText('[role="option"]', story.teammate), signal))
  await press(
    stage,
    await waitFor(() => byText('[role="dialog"] button', `Hand to ${story.teammate}`), signal),
  )

  // Its thread: Riley takes it on. Back in the list, the line shows the thread at work.
  await waitFor(() => location.pathname.startsWith('/app/threads/'), signal)
  await waitFor(() => byText('p', 'Done when'), signal)
  await sleep(1500, signal)
  await press(stage, await waitFor(() => listLink(story.list), signal))
  const chip = () =>
    listLine(story.ask)?.querySelector<HTMLElement>('[data-list-item] [role="link"]')
  await waitFor(chip, signal)
  // The pull request on the line: it waits for a person to merge it.
  const merge = story.presses[0]
  const number = merge.replace('Merge ', '')
  await waitFor(
    () => listLine(story.ask)?.querySelector('[data-list-item]')?.textContent?.includes(number),
    signal,
    60_000,
  )
  await sleep(1500, signal)
  await press(stage, chip)

  // Merged from its thread; back in the list, the line is ticked, credited to Riley.
  await sleep(800, signal)
  await press(stage, await waitFor(() => byText('button', merge), signal, 30_000))
  await waitFor(() => byText('p', story.done), signal, 30_000)
  await sleep(1200, signal)
  await press(stage, await waitFor(() => listLink(story.list), signal))
  await waitFor(() => listLine(story.ask)?.dataset.checked === 'true', signal, 15_000)
  await sleep(1200, signal)
  await press(stage, await waitFor(() => byText('[role="radio"]', 'Done'), signal))
  await waitFor(() => last('section[aria-label="Recently done"]'), signal)
  await sleep(2500, signal)
}

/** A walkthrough. Resolves once the cursor is done; throws Stopped when a person takes over. */
export async function play(stage: Stage, story: Story = 'bug') {
  if (story === 'list') return playList(stage, STORIES.list)
  const { signal } = stage
  const { teammate, ask, presses, done } = STORIES[story]
  // Home: the message box, and who it goes to.
  const picker = await waitFor(() => last('button[aria-label$="Change teammate"]'), signal)
  await waitFor(() => last(EDITOR), signal)
  stage.cursor.hidden = false
  await sleep(900, signal)

  await press(stage, picker)
  const who = await waitFor(() => byText('[role="menuitem"]', teammate), signal)
  await press(stage, who)
  const box = await waitFor(() => last(EDITOR), signal)
  await type(stage, box, ask)
  await send(stage, box)

  // The thread: the teammate works, and each thing that waits for a person gets a yes.
  await waitFor(() => location.pathname.startsWith('/app/threads/'), signal)
  for (const label of presses) {
    const button = await waitFor(
      () => byText('button', label === 'Allow' ? /^Allow$/ : label),
      signal,
      60_000,
    )
    await sleep(1500, signal)
    await press(stage, button)
  }
  await waitFor(() => byText('p', done), signal, 30_000)
  await sleep(1500, signal)
}
