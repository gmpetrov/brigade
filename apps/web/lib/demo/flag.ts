/**
 * The public demo (demo.brigade.lol): the real dashboard on recorded data, built with
 * NEXT_PUBLIC_DEMO=1. Nothing in it reaches an API: requests to DEMO_API never leave the
 * browser (lib/demo/install.ts answers them), and the address does not exist besides.
 */
export const DEMO = process.env.NEXT_PUBLIC_DEMO === '1'
export const DEMO_API = 'https://api.demo.invalid'
/** Where the demo's visitor goes to start for real. */
export const SIGN_UP_URL = 'https://www.brigade.lol/sign-up'
