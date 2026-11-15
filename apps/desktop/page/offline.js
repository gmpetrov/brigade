// Back to the address that failed (only one on the web: the app keeps the window on the
// dashboard's site), on a click and every 10 seconds.
const query = new URLSearchParams(location.search)
const url = query.get('url')
const retry = () => {
  if (url && /^https?:/.test(url)) location.href = url
}
if (query.get('reason'))
  document.getElementById('reason').textContent =
    `Check your connection (${query.get('reason')}). Brigade tries again in a moment.`
document.getElementById('retry').addEventListener('click', retry)
setInterval(retry, 10_000)
