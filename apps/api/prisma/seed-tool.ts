// The sample workspace's tool (docs/tools.md): a review board for the fall launch's visuals.
// It lists them from the library, keeps each person's notes and the team's decisions, and sends
// the decisions to its thread. Plain HTML, as a teammate makes one.

/** The visuals it reviews: four simple SVG ads, in Projects/Fall launch/visuals. */
export const SAMPLE_VISUALS: Record<string, string> = Object.fromEntries(
  [
    ['teams-hero', '#6d28d9', '#ede9fe', 'Meet Acme Teams'],
    ['one-invoice', '#0f766e', '#ccfbf1', 'One invoice, per seat'],
    ['invite', '#b45309', '#fef3c7', 'Invite your team in one click'],
    ['roles', '#be123c', '#ffe4e6', 'Owners, admins, members'],
  ].map(([name, ink, paper, line]) => [
    `${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">` +
      `<rect width="1200" height="675" fill="${paper}"/>` +
      `<circle cx="1010" cy="140" r="220" fill="${ink}" opacity=".14"/>` +
      `<text x="90" y="330" font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="700" fill="${ink}">${line}</text>` +
      `<text x="90" y="420" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="${ink}" opacity=".7">Acme · Fall launch</text>` +
      `</svg>`,
  ]),
)

export const SAMPLE_TOOL_MANIFEST = JSON.stringify(
  {
    title: 'Visual review',
    description:
      'The fall launch visuals: approve or reject each, keep your notes, and send the decisions to Maya.',
    reads: ['Projects/Fall launch/visuals'],
  },
  null,
  2,
)

export const SAMPLE_TOOL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual review</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 14%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 15px; margin: 0; }
  .count { color: color-mix(in srgb, currentColor 60%, transparent); font-size: 13px; }
  .spacer { flex: 1; }
  button { font: inherit; border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
  button.primary { background: #6d28d9; border-color: #6d28d9; color: white; }
  button[aria-pressed="true"].ok { background: #dcfce7; border-color: #16a34a; color: #14532d; }
  button[aria-pressed="true"].no { background: #fee2e2; border-color: #dc2626; color: #7f1d1d; }
  button:disabled { opacity: .5; cursor: default; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; padding: 18px; }
  article { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
  article img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; background: var(--line); }
  .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
  .name { font-weight: 600; }
  .row { display: flex; gap: 8px; }
  textarea { font: inherit; width: 100%; min-height: 54px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; background: transparent; color: inherit; resize: vertical; }
  .note { padding: 18px; color: color-mix(in srgb, currentColor 60%, transparent); }
</style>
</head>
<body>
<header>
  <h1>Visual review</h1>
  <span class="count" id="count"></span>
  <span class="spacer"></span>
  <button class="primary" id="send" disabled>Send decisions</button>
</header>
<main id="grid"></main>
<script>
  var FOLDER = 'Projects/Fall launch/visuals'
  var decisions = { value: {}, version: 0 }
  var notes = {}
  var grid = document.getElementById('grid')
  var sample = [
    { name: 'teams-hero.svg', url: '' }, { name: 'one-invoice.svg', url: '' },
    { name: 'invite.svg', url: '' }, { name: 'roles.svg', url: '' },
  ]

  function render(files) {
    grid.innerHTML = ''
    files.forEach(function (file) {
      var card = document.createElement('article')
      var decided = decisions.value[file.name]
      card.innerHTML =
        '<img alt="">' +
        '<div class="body"><span class="name"></span>' +
        '<div class="row"><button class="ok">Approve</button><button class="no">Reject</button></div>' +
        '<textarea placeholder="Your note (only you see it)"></textarea></div>'
      if (file.url) card.querySelector('img').src = file.url
      card.querySelector('.name').textContent = file.name.replace(/\\.svg$/, '')
      var ok = card.querySelector('.ok'), no = card.querySelector('.no')
      ok.setAttribute('aria-pressed', String(decided === 'approved'))
      no.setAttribute('aria-pressed', String(decided === 'rejected'))
      ok.onclick = function () { decide(file.name, decided === 'approved' ? null : 'approved', files) }
      no.onclick = function () { decide(file.name, decided === 'rejected' ? null : 'rejected', files) }
      var note = card.querySelector('textarea')
      note.value = notes[file.name] || ''
      note.onchange = function () {
        notes[file.name] = note.value
        if (window.brigade.inBrigade) brigade.state.set('notes', notes)
      }
      grid.appendChild(card)
    })
    var done = Object.keys(decisions.value).length
    document.getElementById('count').textContent = done + ' of ' + files.length + ' decided'
    document.getElementById('send').disabled = done === 0 || !window.brigade.inBrigade
  }

  // Decisions are the team's: written over the version read, so two people never overwrite each other.
  function decide(name, what, files) {
    var next = Object.assign({}, decisions.value)
    if (what) next[name] = what; else delete next[name]
    if (!window.brigade.inBrigade) { decisions.value = next; return render(files) }
    brigade.shared.set('decisions', next, { version: decisions.version }).then(function (saved) {
      decisions = saved
      render(files)
    }, function (error) {
      if (error.code !== 'conflict') return alert(error.message)
      // Someone decided meanwhile: show theirs, then the person decides again.
      brigade.shared.get('decisions').then(function (now) { decisions = now; render(files) })
    })
  }

  document.getElementById('send').onclick = function () {
    var lines = Object.keys(decisions.value).sort().map(function (name) {
      return '- ' + name + ': ' + decisions.value[name] + (notes[name] ? ' (' + notes[name] + ')' : '')
    })
    brigade.thread.send('Visual review decisions:\\n\\n' + lines.join('\\n')).catch(function (error) {
      if (error.code !== 'declined') alert(error.message)
    })
  }

  if (!window.brigade.inBrigade) render(sample)
  else
    Promise.all([brigade.files.list(FOLDER), brigade.shared.get('decisions'), brigade.state.get('notes')])
      .then(function (r) {
        decisions = r[1].version ? r[1] : { value: {}, version: 0 }
        notes = r[2].value || {}
        render(r[0].filter(function (f) { return /^image\\//.test(f.contentType) }))
      })
      .catch(function (error) {
        grid.innerHTML = '<p class="note"></p>'
        grid.firstChild.textContent = error.message
      })
</script>
</body>
</html>
`
