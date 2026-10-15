import type { MetadataRoute } from 'next'

/** The dashboard as an installed app: Add to Home Screen on iPhone, Install elsewhere. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/app',
    name: 'Brigade',
    short_name: 'Brigade',
    description: 'The control plane for a business run with AI teammates.',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: '#fdfdfd',
    theme_color: '#7033ff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
