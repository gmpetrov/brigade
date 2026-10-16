// Asks Brigade (setup.rs) for each step every 1.5 seconds and draws them; a
// step's button runs the action that fixes it.
const { invoke } = window.__TAURI__.core

const list = document.getElementById('steps')
const summary = document.getElementById('summary')
const close = document.getElementById('close')
const later = document.getElementById('later')
const errors = new Map()
let busy = null

function render({ steps, done }) {
  const count = steps.filter((s) => s.done === true).length
  summary.textContent = done
    ? 'All set: your teammates can work on this Mac.'
    : `${count} of ${steps.length} done. Each step updates as soon as it's done.`
  close.hidden = !done
  later.hidden = done
  // The first step not done gets the violet button: what to do next.
  const next = steps.find((s) => s.done === false && s.action)
  list.replaceChildren(
    ...steps.map((s) => {
      const item = document.createElement('li')
      item.className = s.done === true ? 'done' : s.done === null ? 'waiting' : 'todo'
      const mark = document.createElement('span')
      mark.className = 'mark'
      const text = document.createElement('div')
      text.className = 'text'
      const title = document.createElement('div')
      title.className = 'title'
      title.textContent = s.title
      const detail = document.createElement('div')
      detail.className = 'detail'
      detail.textContent = s.detail
      text.append(title, detail)
      if (errors.has(s.id)) {
        const error = document.createElement('div')
        error.className = 'error'
        error.textContent = errors.get(s.id)
        text.append(error)
      }
      item.append(mark, text)
      if (s.action) {
        const button = document.createElement('button')
        button.textContent = s.action.label
        if (s === next) button.className = 'next'
        button.disabled = busy === s.action.id
        button.addEventListener('click', () => act(s.id, s.action.id))
        item.append(button)
      }
      return item
    }),
  )
}

async function act(step, action) {
  busy = action
  errors.delete(step)
  try {
    await invoke('setup_action', { id: action })
  } catch (error) {
    errors.set(step, String(error))
  }
  busy = null
  refresh()
}

let pending = false
async function refresh() {
  if (pending) return
  pending = true
  try {
    render(await invoke('setup_state'))
  } finally {
    pending = false
  }
}

close.addEventListener('click', () => invoke('setup_action', { id: 'close' }))
later.addEventListener('click', () => invoke('setup_action', { id: 'close' }))
refresh()
setInterval(refresh, 1500)
