// Tell Bing, Yandex, Seznam and Naver (IndexNow, https://www.indexnow.org) that the pages in
// www.brigade.lol/sitemap.xml changed, so they crawl them again soon. Run after a deploy
// that changes public pages: `node apps/web/scripts/indexnow.mjs`.
// The key is public by design: search engines check it at /<key>.txt (apps/web/public).
const KEY = 'fe6b73dfcdb74ea3a8b0f1347d313272'
const HOST = 'www.brigade.lol'

const sitemap = await (await fetch(`https://${HOST}/sitemap.xml`)).text()
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: `https://${HOST}/${KEY}.txt`,
    urlList: urls,
  }),
})
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urls.length} pages`)
