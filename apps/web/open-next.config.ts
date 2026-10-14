// The dashboard on Cloudflare Workers (OpenNext). It has no ISR or image
// optimization, so it needs no cache bindings.
import { defineCloudflareConfig } from '@opennextjs/cloudflare'

export default defineCloudflareConfig()
