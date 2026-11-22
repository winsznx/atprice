import type { MetadataRoute } from 'next';
import { HOME_DESCRIPTION, SITE_NAME } from '@/lib/seo';
import { OG_COLOURS } from '@/lib/og/theme';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME}: limit orders for Bitcoin Cash tokens`,
    short_name: SITE_NAME,
    description: HOME_DESCRIPTION,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: OG_COLOURS.surface,
    theme_color: OG_COLOURS.surface,
    categories: ['finance'],
    icons: [
      { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
      { src: '/icons/icon-192.png', type: 'image/png', sizes: '192x192', purpose: 'any' },
      { src: '/icons/icon-512.png', type: 'image/png', sizes: '512x512', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
    ],
  };
}
