declare namespace Cloudflare {
  interface Env {
    DocRoom: DurableObjectNamespace<import('./index').DocRoom>
    /** The Brigade API, e.g. https://api.example.com. */
    API_URL: string
    /** Shared with the API (its COLLAB_SECRET). */
    COLLAB_SECRET: string
  }
}
interface Env extends Cloudflare.Env {}
