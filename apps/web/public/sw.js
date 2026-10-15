// Brigade's service worker: notifications only (nothing is cached). The API
// sends a push (apps/api/src/notifications.ts) as JSON: { title, body, url,
// tag, badge, close }. One notification per tag; `close` lists the tags of those
// whose thing no longer waits; `badge` is the app icon's count.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let message
  try {
    message = event.data.json()
  } catch {
    return
  }
  event.waitUntil(
    (async () => {
      if (Array.isArray(message.close) && message.close.length) {
        const shown = await self.registration.getNotifications()
        for (const n of shown) if (message.close.includes(n.tag)) n.close()
      }
      if (typeof message.badge === 'number' && 'setAppBadge' in navigator)
        await (
          message.badge > 0 ? navigator.setAppBadge(message.badge) : navigator.clearAppBadge()
        ).catch(() => {})
      // Every push shows a notification: browsers stop sending those that show nothing.
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        // Replacing one (same tag) is still news.
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: message.url },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? '/app', self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        await open.focus()
        return open.navigate(url).catch(() => self.clients.openWindow(url))
      }
      return self.clients.openWindow(url)
    })(),
  )
})
