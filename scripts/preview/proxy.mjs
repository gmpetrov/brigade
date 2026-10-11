// The preview's one address: /api (requests and WebSockets) to the API, the
// rest to Next. One origin means one preview token, and the dashboard's
// session cookie is first-party to its API.
import http from 'node:http'
import net from 'node:net'

const PORT = Number(process.env.PORT ?? 3000)
const API_PORT = Number(process.env.API_PORT ?? 3001)
const WEB_PORT = Number(process.env.WEB_PORT ?? 3002)

const target = (url = '/') => (url === '/api' || url.startsWith('/api/') ? API_PORT : WEB_PORT)

// Shown while Next starts or restarts, instead of a blank page.
const WAITING =
  '<!doctype html><meta http-equiv="refresh" content="3"><title>Starting…</title>' +
  '<p style="font-family:system-ui,sans-serif;padding:2rem">Brigade is starting. This page reloads by itself.</p>'

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: target(req.url),
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.rawHeaders)
      response.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' }).end(WAITING)
  })
  req.pipe(upstream)
})

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(target(req.url), '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    upstream.write(head)
    upstream.pipe(socket).pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(PORT, '0.0.0.0', () =>
  console.log(`Preview on port ${PORT}: /api to port ${API_PORT}, the rest to port ${WEB_PORT}`),
)
