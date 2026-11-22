import localFont from 'next/font/local';

/*
 * Self-hosted variable fonts (OFL, copied from the pinned @fontsource-variable packages), so the
 * page never requests a font from a third-party host. next/font adds metric-adjusted fallbacks.
 */

export const bricolage = localFont({
  src: './fonts/bricolage-grotesque-latin-wght-normal.woff2',
  variable: '--font-bricolage',
  weight: '200 800',
  display: 'swap',
});

export const inter = localFont({
  src: './fonts/inter-latin-wght-normal.woff2',
  variable: '--font-inter',
  weight: '100 900',
  display: 'swap',
});

export const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-wght-normal.woff2',
  variable: '--font-jetbrains',
  weight: '100 800',
  display: 'swap',
  adjustFontFallback: false,
});
