// The rules a teammate reads (its widget_guide tool) before it draws a widget
// with show_widget. What a widget looks like comes from here, so examples are
// spelled out in full.
import { WIDGET_HTML_MAX, WIDGET_THEME_VARS } from '@brigade/contracts'

export const WIDGET_GUIDE = `# Drawing a widget

A widget is a visual you draw in the thread with \`show_widget\`: a few options side by side, a diagram, a chart of data you have, a comparison worth seeing. It explains or helps decide something now, and it is not kept: it lives in the thread only.

## When

- Draw one when seeing beats reading: variants of a small UI change, a flow or how parts connect, numbers that make a shape, a before and after.
- Do not draw one when a sentence does it, and never in place of the answer: your reply still says what matters.
- A page, screen, prototype, slides or anything someone will keep, comment on or build from is a design, not a widget.
- Draw it in your final reply, after the work, at most one or two per reply.

## The frame

- Your HTML is the body of a page as wide as the thread: about 640px, down to 320px on a phone. Lay it out to fit both (\`display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))\`).
- The page has no margin and a transparent background, and the thread draws a rounded border around it with its title beneath. Do not set a background on \`body\`, add outer margins, or wrap the whole widget in another card or a heading that repeats the title.
- Everything fits its box at the narrowest width: a variant in a 240px card must not overflow it. Shorten a label rather than let it spill or clip.
- Its height follows its content. Never use \`vh\`, \`height: 100%\` on the page, or anything that grows to fill: give charts and canvases a fixed height.
- Keep it under ${Math.round(WIDGET_HTML_MAX / 2000)} KB (the limit is ${WIDGET_HTML_MAX / 1000} KB): it is written in one go and shows only when done.

## Theme

The dashboard passes in its theme, light or dark. Use these variables for every color, font and corner, never a hard-coded color, so the widget works in both:

${WIDGET_THEME_VARS.map((v) => `\`${v}\``).join(', ')}

- Text: \`var(--foreground)\`, secondary text \`var(--muted-foreground)\`. Surfaces: \`var(--card)\` with \`1px solid var(--border)\`; a subtle fill \`var(--muted)\`. Accent: \`var(--primary)\`, sparingly.
- Charts: \`var(--chart-1)\` to \`var(--chart-5)\` for series; \`var(--success)\`, \`var(--warning)\`, \`var(--destructive-text)\` only for good, caution and bad.
- Fonts: \`var(--font-sans)\`, and \`var(--font-mono)\` for code and keys. The body already uses the sans font at 14px.
- When the person switches theme, the variables change in place and \`window\` gets a \`themechange\` event: a canvas chart, which reads colors once, redraws on it.
- Sizes in px. \`--radius\` is large; for cards use \`calc(var(--radius) * 0.5)\`, for small chips \`6px\`.
- A widget that shows the person's own product (their button, their card) draws those parts with their design system's values: copy the few tokens you need into the HTML, since the widget cannot load files.

## What works and what is blocked

- Inline \`<style>\` and \`<script>\`, inline SVG, \`data:\` images.
- Scripts from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com, with an exact version (\`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js\`).
- Blocked: network requests (\`fetch\`, images or fonts from other sites), stylesheets from CDNs (so no Tailwind CDN), forms, links and opening pages, \`localStorage\`. Put the data in the page.
- Buttons in the widget cannot send anything; to let the person pick, see Options.

## Options

When you offer alternatives:
1. Number them in the widget, each a card with its number and a short name, the variant drawn, and one line on what sets it apart.
2. End your reply with a \`choices\` block, one option per card, its label the same number and name ("3 · Small square caps"), without \`design\`. The pick arrives as the person's next message, "Go with 3 · Small square caps": other teammates see that, never the widget, so the name must say what it is.

## Quality

- One idea per widget. A short heading only if the thread does not already say what it is.
- Plain labels in the person's words; no lorem ipsum, no placeholder data when you have the real thing.
- Consistent spacing (multiples of 4px), aligned edges, at most two text sizes besides headings.
- Nothing decorative that does not explain: no gradients, shadows or icons for their own sake.

## Examples

Options grid:

\`\`\`html
<style>
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .opt { border: 1px solid var(--border); border-radius: calc(var(--radius) * 0.5); background: var(--card); padding: 16px; }
  .opt h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  .opt p { margin: 12px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
  .stage { display: flex; align-items: center; min-height: 56px; padding: 0 12px; border-radius: 8px; background: var(--muted); }
</style>
<div class="grid">
  <div class="opt">
    <h3>1 · Plain text</h3>
    <div class="stage">…the variant…</div>
    <p>Just the symbols, small and faint.</p>
  </div>
  …
</div>
\`\`\`

Diagram (inline SVG, colors from the theme):

\`\`\`html
<svg viewBox="0 0 600 120" width="100%" role="img" aria-label="Request flow" style="font: 13px var(--font-sans)">
  <rect x="0" y="40" width="140" height="40" rx="8" fill="var(--card)" stroke="var(--border)"/>
  <text x="70" y="65" text-anchor="middle" fill="var(--foreground)">Dashboard</text>
  <path d="M140 60 H220" stroke="var(--muted-foreground)" marker-end="url(#arrow)"/>
  …
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--muted-foreground)"/></marker></defs>
</svg>
\`\`\`

Chart (a fixed-height box; read theme colors from the page, since a canvas cannot use CSS variables):

\`\`\`html
<div style="position: relative; height: 240px"><canvas id="c"></canvas></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
  new Chart(document.getElementById('c'), {
    type: 'bar',
    data: { labels: ['Jan', 'Feb', 'Mar'], datasets: [{ data: [12, 19, 7], backgroundColor: css('--chart-1') }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: css('--muted-foreground') }, grid: { display: false } },
                y: { ticks: { color: css('--muted-foreground') }, grid: { color: css('--border') } } } },
  })
</script>
\`\`\`
`
