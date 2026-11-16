# Themes

A member restyles Brigade for themselves by talking with a teammate: "give Brigade a Solarized
look", "make the sidebar feel like paper", "bigger, squarer buttons". The teammate writes a
theme, and every window the member has open in the workspace (web and Brigade.app) wears it at
once. Nobody else's windows change. Behind the `themes` feature (docs/feature-flags.md).

A theme changes the look, never the layout or behaviour: it cannot move the sidebar, add a panel
or change what a screen does. Teammates are told so, and told never to hide or disguise what asks
the person to decide.

## What a theme is

`ThemeFile` in `packages/contracts/src/themes.ts`:

| Field              | What it does                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | Shown in Preferences and on the thread's card.                                                                                                                                             |
| `canvas`           | The base background, hex. The dashboard derives its surfaces, borders and text from it (`apps/web/lib/theme-palette.ts`, `color-mix` in the browser), and turns light or dark to match it. |
| `accent`           | The highlight, hex: buttons, links, the focus ring, with text that reads on it.                                                                                                            |
| `colors`           | Single colour tokens of `apps/web/app/theme.css` (`background`, `primary`, `sidebar`…), over what canvas and accent derive. A colour, never a file.                                        |
| `radius`           | Roundness, a length.                                                                                                                                                                       |
| `font`, `fontMono` | Font-family lists.                                                                                                                                                                         |
| `css`              | A stylesheet applied after the dashboard's own, up to 100,000 characters.                                                                                                                  |

A theme's files (images and fonts, no SVG, 5 MB each, 30 per theme) are in the bucket
(`themeFileKey`). Its stylesheet names one as `url("theme:<file>")`.

Stylesheets target the stable selectors of `THEME_HOOKS` (`data-look="…"` attributes on
Brigade's own surfaces, and shadcn's `data-slot` names): every other class name is a Tailwind
utility that changes between releases. `apps/web/test/theme-hooks.test.ts` fails when one leaves
the code: removing one breaks people's themes, so change the list with it, on purpose.

## Nothing loads from elsewhere

A theme's stylesheet could otherwise send what the page shows to another site (a selector per
character, a background image per match). So a theme loads only its own files, images or fonts
inline as `data:` addresses, and `#fragments`:

- The API reads the text first (`themeCssProblem`) and refuses `@import`, `image-set()`,
  `image()`, `src()`, `cross-fade()`, `element()`, `attr()` making a URL, a backslash escape
  outside a string, and any other `url()`, with words a teammate can act on.
- The dashboard is the guard (`apps/web/lib/theme-css.ts`): it parses the stylesheet into a
  constructed `CSSStyleSheet` (which loads no `@import`), then checks every declaration as the
  browser parsed it, escapes resolved. A declaration that could load from elsewhere is dropped,
  and so is any kind of rule not known to be safe (`@counter-style`, whose symbols can be
  images, or one a browser adds later). Only then do `theme:` files get their signed addresses.
- Colours are checked to be colours (no `url`, `var`, `image`…) on both sides.

## Files never go through the API

The member's windows ask `GET /api/themes/active` for the worn theme with each file's signed
address in the bucket. Addresses are signed from the start of a 12-hour window and work 24 hours,
so a file keeps the same address through the window and the browser keeps it in its cache; the
dashboard asks again an hour before they stop working. The bucket's CORS rules let the dashboard
load fonts from it. Only without R2 (development) does the API serve a file itself
(`GET /api/themes/files/:id`).

A teammate's file is read as the teammate sees it, uploaded by the runner straight to the bucket
(an upload of purpose `theme_file`), then checked by its leading bytes to be the image or font its
name says before it is copied to the theme.

## Changes and going back

Every change (made, edited, wore, off, deleted, undid) is kept with the look right after it
(`ThemeChange`): the member's latest change is the look they wear. The last 30 are kept. Going
back returns to one of them, saving that theme again as it was then; an undo is itself a change,
so undoing it again is a redo. Each change tells the member's open windows (`theme.changed`, sent
only to them through the workspace's hub). A window wears only its latest load's answer: an older one coming back late is dropped.

## Getting out of a theme that hides too much

- ⌘⌥⇧R (Ctrl+Alt+Shift+R) takes the theme off, in every window.
- The member's menu has "Take off <theme>" while one is worn.
- Opening the dashboard with `?safe-look` keeps that tab without the theme until it closes, with
  a pill to wear it again.
- The thread's card has Undo, for the member whose look it is.
- Preferences → Appearance lists the themes, the last changes ("Go back here"), import and export.

A theme dresses the dashboard's pages (`/app`) only, never the public site. The worn theme's
colours are kept in the browser and put on the page by a script in its head, before it paints.

## Teammate tools

In a thread a person started (never a trigger's, a schedule's or a playbook's run), while that
person has the feature (`ThreadSpec.themes`):

| Tool             | What it does                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `theme_read`     | The person's themes, the worn one, their last changes with their numbers, and the guide. |
| `theme_set`      | With `theme`: save it and wear it. With only `id`: wear a saved theme, or `none`.        |
| `theme_add_file` | Copy an image or font from the teammate's folder into a saved theme.                     |
| `theme_undo`     | Go back `steps` changes, or to the look right after change `seq`.                        |

The theme is always the thread starter's, and only while they alone ask in the thread: once another member asks there (`shownAccounts`), the tools are no longer offered and the API refuses them, so nobody else's words restyle (or hide controls in) the starter's dashboard. An API from before themes answers the tools with
"Brigade's server does not have themes yet".

## Sharing

A theme is one member's in one workspace. To share one, the member exports it from Preferences
(one `.brigade-theme.json` with its files inlined) and another imports it: the import is checked
exactly as a teammate's theme is, all or nothing: every file is checked and stored before the theme is saved and worn, and a theme it would replace keeps its look and files when any of it is refused.
