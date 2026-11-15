// The find bar (find.html): searches as the person types, Enter for the next match and
// Shift+Enter for the previous one, Esc to close (src/find.ts does the searching).
const find = window.brigadeFind
const text = document.getElementById('text')
const count = document.getElementById('count')
const previous = document.getElementById('previous')
const next = document.getElementById('next')
const mac = navigator.platform.startsWith('Mac')

function show({ active, matches }) {
  count.textContent = text.value ? `${matches ? active : 0}/${matches}` : ''
  previous.disabled = next.disabled = !matches
}

text.addEventListener('input', () => {
  if (!text.value) show({ active: 0, matches: 0 })
  find.search(text.value)
})
text.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  find.step(!event.shiftKey)
})
document.addEventListener('keydown', (event) => {
  const mod = mac ? event.metaKey : event.ctrlKey
  const key = event.key.toLowerCase()
  if (event.key === 'Escape') find.close()
  else if (mod && key === 'f') text.select()
  else if ((mod && key === 'g') || event.key === 'F3') find.step(!event.shiftKey)
  else return
  event.preventDefault()
})
previous.addEventListener('click', () => find.step(false))
next.addEventListener('click', () => find.step(true))
document.getElementById('close').addEventListener('click', () => find.close())

find.onOpen((last) => {
  if (!text.value && last) text.value = last
  text.focus()
  text.select()
})
find.onResult(show)
find.onTheme((dark) => document.documentElement.classList.toggle('light', !dark))
