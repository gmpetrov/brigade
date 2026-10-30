# Design canvas: plan

A design opens as a canvas: its boards laid out side by side, panned and zoomed
like Figma. A person selects an element on a board and changes its text, size,
spacing, colours and links in a properties panel; each change is written into the
design's HTML as a new version, credited to them. What cannot be changed by hand
(content a script builds) says so and offers to ask the teammate, as today's
comments do. Designs stay plain HTML folders in the library: everything that works
on a design today (knobs, options, comments, export, hand-off, check_design) keeps
working, and a design saved before this opens as a canvas of one or two boards.

Phase 1 is the canvas, phase 2 direct edits. A fast in-page edit agent and live
presence come later (end of this file).

## What a person sees

1. A design opens on a canvas: one board per screen the teammate made (sign-in,
   home, settings…), each with its title above it. A design without boards shows
   its `index.html` once per viewport in its manifest (desktop and mobile side by
   side), a deck as one board. An options set shows each option as a row with its
   name above it, instead of tabs. The title's menu lists the set's options (by
   their titles) and "All side by side" to switch between them, from the thread
   too, where an option opens alone; ← and → go to the previous and next option
   while the panel has the focus.
2. Trackpad or wheel pans; pinch or Ctrl/⌘ + wheel zooms; space + drag pans;
   `⇧1` fits everything, `⇧2` the selection, `⌘0` is 100 %. A zoom menu shows the
   percentage. Over a board whose page scrolls, the wheel scrolls the page.
3. In **Select** (the default) the boards do not get clicks: hovering outlines an
   element, a click selects it, ⇧-click adds to the selection, Escape selects the
   parent, then nothing. In **Play** the boards work as pages.
4. With an element selected, the properties panel on the right shows its
   computed values and edits them: text (the words, size, weight, line height,
   letter spacing, colour, align), size (width, height: px, auto, fill), layout
   when it is a flex or grid container (direction, gap, align, justify, wrap),
   padding, margin, fill, opacity, radius, border, and for a link its address, for
   an image its address and alt text. Double-click a text to retype it in place.
   ⌘Z / ⇧⌘Z undo and redo.
5. Changes show at once and are saved a moment after the last one: a new version
   of that board's file, by this member (folded with their next edits for ten
   minutes, like any library save). If someone saved the file meanwhile, the panel
   says so and reloads the board. The gallery's picture follows.
6. An element a script made or changes says "Made by the page's script: ask
   <teammate> to change it" and offers the Ask box. The Ask box (today's comment
   box) is at the top of the panel for any selection; its message names the board,
   the element (`data-id`, else a CSS path) and its line in the file.
7. Knobs stay as they are, in the panel's Knobs tab. Export, hand-off, reload and
   open-in-a-tab stay in the toolbar.
8. In the narrow panel beside a thread the canvas pans, zooms, selects and asks;
   Edit expands the design over the page, where the properties panel has room.

## Pieces

### 1. Contracts (`packages/contracts/src/design.ts`)

- `DesignBoard = z.object({ file, title?, width?, height?, x?, y? })`:
  - `file`: an `.html` path relative to the design folder, no `..`, no leading
    `/`, no dot segment.
  - `width` px, 200–4000, default 1280.
  - `height` px, 200–8000. Absent: the page's own height when it does not depend
    on the frame's (no `vh` sizing), else the viewport's usual height (800 for
    a width over 1000, 1180 over 600, else 844) with the page scrolling inside.
  - `x`, `y` canvas px, ±200 000; absent = laid out in a row after the previous
    board, 80 px apart.
- `DesignManifest.boards`: entries parsed one by one, a bad one dropped
  (`DesignBoard.nullable().catch(null)`, then filtered), max 60. The field itself
  falls back to absent, so a bad `boards` never loses the title, kind or viewports.
- `designBoards(manifest)`: the boards to draw. With `boards`, those; without, one
  board of `index.html` per viewport in `viewports` (desktop 1280, tablet 820,
  mobile 390; desktop alone when none), a deck one 1280-wide board. Then places
  filled in (`x`, `y`). Shared by the web and the runner's renderer.
- `DesignView` gains `files: Record<string, string>`: every HTML file of the
  design, by its path in the folder, to its sha256. The view's `url` stays the
  entry; a board's page is that url with its file in place of `index.html`.
- Editing:
  - `DesignEditOp`, one of:
    - `{ id, style: Record<property, string | null> }`: set or remove inline
      declarations. Property `^-?[a-z][a-z-]{0,40}$`; value up to 200 characters,
      without `; { } < > \`, `/*`, `expression(`, `javascript:`; `url(…)` only
      with a relative or `https:` address.
    - `{ id, text: string }`: the element's text, up to 10 000 characters.
    - `{ id, attrs: Record<name, string | null> }`: only `href`, `src`, `alt`,
      `title`, `placeholder`, `aria-label`; `href`/`src` relative, `https:`,
      `http:`, `mailto:`, `tel:` or `#…`, checked after decoding entities and
      dropping control characters and whitespace.
  - `DesignEdit = { path (the folder), file, sha256 (of the page that was
shown), ops (1–50) }` → `{ sha256, updatedAt }`.
- Runner: `library.call` gains `{ name: 'design_edits', path }` (below).
- Tests (`packages/contracts/test/design.test.mjs`): boards default, drop bad
  entries and lay out; legacy manifests give one board per viewport; ops refuse
  event attributes, `javascript:` and `&#106;avascript:` addresses, `</style`,
  `expression(`.

### 2. The source of a board (`apps/api/src/design-source.ts`, new)

Uses `parse5` (in the lockfile; added to the API's dependencies) with source
locations: UTF-16 offsets into the file's text, which is what JavaScript string
slicing uses. One numbering serves serving and editing, so it is one function.

- `elementsOf(html)`: the elements written in the file, in document order, with
  their start tag, end tag and attribute spans. Skipped: elements with no source
  location (implied `html`, `head`, `body`, `tbody`), a second element at a start
  offset already seen (the parser rebuilds formatting elements like `<b>` across
  misnested tags), the inside of `<template>`, `<script>`, `<style>`, `<noscript>`,
  and the children of `<svg>` and `<math>` (an icon is selected whole). Each gets
  `id` = its index in that list; `line` = its start line.
- `annotate(html)`: adds `data-bid="<id>:<line>:<fingerprint>"` to every element
  inside `<body>` by inserting right after its tag name; nothing else in the file
  changes. The fingerprint is a short hash of its own text nodes (whitespace
  collapsed): the bridge compares it with the live element to tell text a script
  set.
- `applyEdits(html, ops)`: the same numbering, then each op as a splice of the
  original text, from the end of the file backwards so offsets stay valid:
  - style: parse the `style` attribute's declarations (decoded), set or remove,
    write them back as `a: b; c: d` in a double-quoted attribute with `&`, `"` and
    `<` escaped, or add one after the tag name.
  - text: only for an element whose source has an end tag and no element
    children, with no other element's tag inside its span (else 400: "Retype one
    piece of text at a time"); replaces what is between its tags, escaped.
  - attrs: replace, add or remove the attribute, double-quoted and escaped.
  - Several ops on one element apply in order.
- Pure functions over strings, no database: tested with `node --test` on HTML that
  teammates write (Tailwind classes, inline SVG icons, scripts that build lists,
  `<template>`, a deck, misnested and implied tags, emoji before the edit).

### 3. API

- `designFiles` (the sandbox host): an HTML page of a design gets `annotate()`,
  the knobs style and the bridge, the bridge first in `<head>` so it runs before
  the page's scripts (`addToHead(html, tags, { first: true })`: after
  `<head(\s|>)…>`, else after the doctype). The bridge's tag carries the file's
  path and the sha256 it was annotated from. Annotated HTML is sent `no-store`:
  a cached page would carry another numbering. The zip and the runner's renders
  stay unannotated.
- `openDesignView` fills `files`.
- `PATCH /api/designs/edit` (`DesignEdit`): the file must be an `.html` row in a
  design folder. Under a per-file lock in the API process: its sha256 must be the
  one the page was annotated from, else 409 with the current sha256 ("Someone
  saved this board meanwhile"); then `applyEdits` and `saveLibraryFile` as the
  member (members may already write any library file). Audit `design.edited` with
  the folder, file and op kinds.
- `PUT /api/designs/thumbnail` (`{ path, png }` as base64, up to 2 MB, a PNG by its
  signature): the canvas's picture of the first board after a person's edits.
- Teammates and people's edits: `library.call { name: 'design_edits', path }`
  answers the files of a design whose latest version is a member's and newer than
  this thread's last save of that file (or the thread's start when it never saved
  it), with who and when. `save_design` asks first and, unless `overwrite: true`,
  refuses before saving anything: "<Name> edited `index.html` on the canvas
  after you last saved it. Copy the library's copy (`<libraryDir>/<path>`) into
  your folder and make your change on it, then save. If your file was made from
  that copy, save again with `overwrite: true`." Old runners do not ask: their
  saves go through as today.

### 4. The bridge (`apps/api/src/design-bridge.ts`)

Still plain JavaScript in a string, talking only by `postMessage`, inert in a
page that is not framed. Today's messages stay (pick, vars, print, capture), so
nothing breaks while the canvas comes in. Select needs no event blocking in the
page: the canvas lays a transparent layer over each board and asks the page what
is under the pointer. New messages:

- **Hit** (`brigade:hit {x, y, id}` → `hit {id, bid, rect, …}`): the element at
  that point (`elementFromPoint`), climbed to the nearest with a `data-bid`, else
  itself with `bid: null` (made by script). Rects are in the page's px; the canvas
  draws outlines in its own layer, crisp at any zoom.
- **Inspect** (`brigade:inspect {bid}` → `inspected`): tag, a label (its first
  words, an image's alt), `data-id`, line, CSS path, the computed values the panel
  shows, its inline declarations, whether it is a flex or grid container, and
  `editable: { text, style, attrs }`. Style and attributes are editable when it
  has a `data-bid` that appears once in the page (a script's clone of an element
  copies it); text when it also has only text children and its text still has the
  fingerprint (else `scripted: true`).
- **Rects** (`rects {bids: rect[]}`): the selection's rects again when they move
  (scroll, resize, mutation), at most once a frame.
- **Size** (`size {height, scrolls}`): once loaded (fonts ready, then a frame) at
  the viewport's usual height, the page's height; the canvas grows the frame to it
  and the bridge measures again: when the page grew with the frame (`vh`), the
  canvas puts the frame back to the usual height and the page scrolls inside
  (`scrolls: true`). Later only when the content changes size by itself, at most
  once a second, capped at 8 000 px.
- **Wheel**: Ctrl/⌘ + wheel always goes to the canvas (zoom). In Play, a wheel
  nothing under the pointer can scroll goes to the canvas (pan). Listeners are
  non-passive so they can stop the page's own.
- **Live changes** (`brigade:style {bid, style}`, `brigade:attrs`,
  `brigade:text`): applied to the page at once, before the save. The canvas sends
  them to every board showing that file.
- **Retyping** (`brigade:edit-text {bid}`): the canvas focuses the frame, then the
  bridge makes the element `contenteditable="plaintext-only"`, selects its text,
  and on blur or Enter sends `typed {bid, text}`. The canvas takes `typed` only for
  the element it asked to retype. When focus does not reach the page, the text
  field in the panel does the same.

A page's own script can send any of these messages. They only ever fill the
canvas (outlines, the panel) or, for `typed`, write escaped text into the element
a person chose to retype, in a design the script's author can already change.
Nothing a page sends reaches the API by itself.

### 5. The canvas (`apps/web/components/design-canvas.tsx` and friends, new)

- `design-canvas.tsx`: the world (a div under `translate() scale()`), pan and zoom
  from wheel, pinch (Safari's gesture events), space + drag and the bridge's wheel
  messages; fit on open; a toolbar (Select / Play, zoom menu); board titles; a
  transparent layer over each board in Select for hover and click; selection and
  hover outlines above the world; shortcuts while the canvas has focus.
- `design-board.tsx`: one board: an iframe of its file from the sandbox origin
  (same sandbox attribute and referrer policy as today), its messages matched by
  `e.source`, its size. Mounted only while within a screen of the view, else a
  frame with its title. It keeps its address while its file's sha256 is the one
  it shows or one its own edits made, so the view refetching (a new token) does
  not reload it; another sha256 (a teammate saved) reloads it.
- `design-properties.tsx`: the panel (Ask, Properties, Knobs tabs). Values from
  `inspected`; live styles to the boards; ops to the queue. Lengths in px unless
  the value already uses another unit; colours with a picker and the text value;
  inputs commit on Enter or blur; arrows step by 1, ⇧ by 10. On a file shown on
  several boards it says the change applies at every size.
- `design-edits.ts`: the queue per file. Ops wait 600 ms after the last change,
  then one `PATCH /designs/edit` with the sha256 the boards were annotated from;
  the answer's sha256 is the next one. Undo keeps each op's previous values (from
  `inspected`) and queues the reverse op; redo the op again. A 409 drops the
  queue, reloads the file's boards and says so. 3 s after the last save of the
  first board's file, it captures that board (`brigade:capture`, half size) and
  saves the picture.
- `design-view.tsx`: `DesignFrame` becomes the canvas; options become rows (each
  option's view fetched, its boards in its own row under its name), so
  `DesignPanel` drops the options tabs. The comment box becomes the Ask tab, with
  today's message plus the board and line. Export, hand-off, reload and
  open-in-a-tab stay; PNG export captures the selected board, else the first.

### 6. Runner (`apps/runner/src/harness/tools.ts`, `design-shot.ts`)

- `save_design`: checks that every board's file is in the folder (and
  `index.html`, as now); asks `design_edits` and refuses as above unless
  `overwrite: true`.
- `check_design`: one screenshot per board, its file at its width and height (the
  full page when it has none, up to 8 000 px), named after the board; a deck as
  today.
- The thumbnail is the first board's.

### 7. Instructions (`apps/runner/src/instructions.ts`, `## Designs`)

- Boards: when a design has several screens, states or sizes, make each its own
  HTML file and list them in `design.json` `boards` (`{"file": "signin.html",
"title": "Sign in", "width": 1440}`), in reading order; `index.html` is still
  the first. Places are optional. A page meant to be seen whole gets no `vh`
  sizing; a screen (an app, a phone) gets a `height`.
- Markup first: write what the page shows as HTML, with styles as classes or
  inline; scripts for behaviour (menus, tabs, state), not to build the content.
  People retype text and change styles on the canvas, and cannot change what a
  script builds.
- People edit designs by hand: before changing a saved design, copy its files from
  the library (`<libraryDir>/<path>`) over your working copy.
- Comments name the board and the line.

### 8. README

The design section (`README.md`, "Designs") gains the canvas, boards, editing and
the rule for saves over a person's edits.

## Order of work

1. Contracts (boards, ops) and their tests.
2. `design-source.ts` and its tests.
3. API: annotate when serving, `files` in the view, edit and thumbnail routes,
   `design_edits`.
4. Bridge: hit, inspect, rects, size, wheel, live changes, retyping.
5. Canvas: boards, pan and zoom, Select / Play, options as rows, Ask (phase 1).
6. Properties panel, edit queue, undo, thumbnail.
7. Runner tools, renderer and instructions; README.
8. Run it: a seeded design with several boards and an options set, in the preview.

## Not now

- Deleting, duplicating, moving or resizing elements on a board; adding elements;
  moving, resizing or adding boards (and saving places). Ask the teammate.
- A Layers list.
- Telling the teammate in `check_design` how much of a page is editable.
- A fast edit agent in the page (Claude streams jQuery against a copy of the
  page): needs a model call from the API, which Brigade does not make.
- Live presence and editing together: two people on one board meet the 409.
- Editing a class's rules (a class's style is overridden inline instead).
- One template node rendering many times (`<template data-each>`), if lists built
  by script turn out to be what people most want to change.

## Risks

- **Numbering drift.** The bridge's ids and the API's must be the same list. Both
  come from `elementsOf` over the same bytes: the served page carries the sha256
  it was annotated from, is never cached, and an edit against another sha256 is
  refused.
- **Height.** A page sized by `vh` cannot be shown whole; it shows a screen and
  scrolls. Measuring twice per load costs a frame of layout.
- **Many frames.** Each board is a full page; boards off screen are unmounted.
- **Teammates overwriting people.** The refusal costs a round trip after a hand
  edit, and a model may pass `overwrite: true` without looking; the instruction to
  copy from the library first is what keeps edits.
- **Focus in the frame.** Retyping in place needs the page to take focus from the
  canvas; when a browser refuses, the panel's text field is the way.
