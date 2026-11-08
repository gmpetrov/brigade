# Public links

A member turns on a library file's **public link**, and anyone with its address,
`www.brigade.lol/s/<token>`, reads the file as it is now, without signing in. It is how a
document, a design or a deck made in Brigade replaces the Google Doc or the PDF sent to a client
or an investor: the person reading it needs no account, and always sees the latest version.

## What a member sees

- **Share** sits in the bar of whatever shows the file: a document's panel (an icon between
  Ask and History), any other file's panel (beside Download), and a design's bar (a button with
  its text, like Comment and Knobs). Its panel has one switch, "Anyone with the link can view",
  the link with **Copy**, and a line on what the link shows.
- While the link is on, the icon is a globe and the bar's caption says **Public link** beside
  the file's folder, as the Library's rows do (a design's row too, from its `index.html`): anyone
  in the workspace sees at a glance what can be read from outside.
- Viewers see whether a file is shared and its link; they turn nothing on or off (the API
  refuses their writes, `src/viewers.ts`). Teammates have no tool for it: publishing is a
  person's decision.

## What the link shows

`apps/web/app/s/[token]/page.tsx`, from `GET /api/shared/:token` (`apps/api/src/routes/shared.ts`).
A thin bar says the file's name, "Shared by <workspace>", and links to Brigade ("Made with
Brigade"). Under it:

- **A Markdown document** as a page (`components/public-markdown.tsx`). The API prepares its text
  (`publicMarkdown`, `src/library-shares.ts`): mentions of the workspace's files, threads and
  teammates become their names alone, hidden markers (list items' ids) go, and the files
  uploaded into the document (`asset:<id>`) become addresses under the link, which serve only the
  files the document refers to now. Checklists show where they stand and change nothing. The
  document's discussions are not shown.
- **A design**, its whole folder: the link is its `index.html`'s. The page frames it from the
  sandbox origin (`DESIGN_URL`, `/s/<token>/…`), served as on the canvas (sandboxed, its knobs'
  values applied) but without the canvas's bridge or element numbers.
- **Any other file** as the library previews it (images, video, audio, PDFs, Word documents,
  spreadsheets, decks, text), with **Download**. Its bytes come under the link with the
  library's rules: shown inline only for types that cannot run script on the API's origin.

Every answer is the file as it is now, never cached (`no-store`), and carries
`x-robots-tag: noindex`; the page is kept out of search engines too.

## Decisions

- **The token is the key, and it lives in the row** (`LibraryShare`, one per file), not in a
  signed address: turning the link off deletes the row, so the address stops at once, and turning
  it on again gives a new one. A signed address could not be taken back. A video or a large file
  already opened plays on from the bucket's short-lived address (5 minutes) it was given; a new
  request is refused.
- **One link per file, read only, latest version.** No expiry, password or pinned version yet:
  each is a control to add when people ask for it.
- **The link follows the file.** Renaming or moving keeps it (it points to the file's row). While
  the file is in the trash, the link answers as off; restored, it works again; deleted for good,
  it goes with the file.
- **Through a link, nothing else of the workspace.** The token names one file; a document's link
  serves only the files it refers to, a design's only its own folder, and neither reveals ids or
  paths of anything else beyond what the file's own text says.
- **A design's page stays on the sandbox origin.** Its script runs as on the canvas: sandboxed,
  with no cookies, no forms and no calls beyond public CDNs (`DESIGN_CSP`, `src/designs.ts`). The
  page at `/s/<token>` frames it, as the dashboard does.

## Where it is

- API: `src/library-shares.ts` (turning links on and off, what a link shows), the member routes
  `GET|POST|DELETE /api/library/:id/share` (`src/routes/library.ts`), the public routes
  `/api/shared/:token`, `/content`, `/preview`, `/assets/:id` (`src/routes/shared.ts`), and the
  sandbox host's `/s/<token>/…` (`sharedDesignFiles`, `src/designs.ts`). Turning one on or off is
  in the audit log (`library.shared`, `library.unshared`) and tells dashboards (`library.updated`).
- Dashboard: `components/share-button.tsx` (the button, its panel, `useShare`), the public page
  `app/s/[token]/page.tsx`.
- Tests: `apps/api/test/library-shares.test.ts`.
- In a preview, whose one address is the sandbox origin too, `scripts/preview/proxy.mjs` sends
  `/s/<token>/…` (and `/v/<token>/…`) to the API, and `/s/<token>` to the page.
