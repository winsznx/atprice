import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { colourToken } from './tokens';

/*
 * Everything a generated image needs from disk, read once at module scope: none of it depends on the
 * request. Literal paths under process.cwd() let the build trace exactly these files.
 */

const TOKENS_CSS = readFileSync(join(process.cwd(), 'app/tokens.css'), 'utf8');

const token = (name: string): string => colourToken(TOKENS_CSS, name);

export const OG_COLOURS = {
  fg: token('fg'),
  fgSecondary: token('fg-secondary'),
  fgMuted: token('fg-muted'),
  surface: token('surface'),
  surfaceSunken: token('surface-sunken'),
  border: token('border'),
  brand: token('brand'),
  brandFg: token('brand-fg'),
  brandSubtle: token('brand-subtle'),
  focusInverse: token('focus-inverse'),
} as const;

export type OgTone = 'open' | 'pending' | 'filled' | 'cancelled' | 'failed' | 'review';

/** A status chip's text and tint, the same pairs `StatusBadge` uses on the page. */
export const ogToneColours = (tone: OgTone): { readonly fg: string; readonly bg: string } => ({
  fg: token(`status-${tone}`),
  bg: token(`status-${tone}-subtle`),
});

/**
 * DD 2 mark. `app/icon.svg` is the favicon and a byte-for-byte copy of `internal/design/mark.svg`
 * (lib/og/theme.test.ts holds them equal); it is read from inside the app so a request-time render never
 * depends on files outside the deployed project.
 */
export const MARK_SVG = readFileSync(join(process.cwd(), 'app/icon.svg'), 'utf8');
export const MARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG).toString('base64')}`;

/*
 * Satori reads neither WOFF2 nor variable fonts, so lib/og/fonts holds static TrueType instances of the
 * app's own fonts (app/fonts/*.woff2, OFL) at the weights the cards use, cut to Latin with fontTools'
 * instancer and subsetter. Neither latin subset has `≈`, which a rounded limit prints, so a small subset
 * of Geist (OFL, the font next/og bundles) covers general punctuation, arrows and maths; without it,
 * next/og would fetch the missing glyph from Google Fonts at render time.
 */
export const OG_FONTS = [
  {
    name: 'Bricolage Grotesque',
    data: readFileSync(join(process.cwd(), 'lib/og/fonts/bricolage-grotesque-400.ttf')),
    weight: 400 as const,
    style: 'normal' as const,
  },
  {
    name: 'Bricolage Grotesque',
    data: readFileSync(join(process.cwd(), 'lib/og/fonts/bricolage-grotesque-600.ttf')),
    weight: 600 as const,
    style: 'normal' as const,
  },
  {
    name: 'Inter',
    data: readFileSync(join(process.cwd(), 'lib/og/fonts/inter-500.ttf')),
    weight: 500 as const,
    style: 'normal' as const,
  },
  {
    name: 'Inter',
    data: readFileSync(join(process.cwd(), 'lib/og/fonts/inter-600.ttf')),
    weight: 600 as const,
    style: 'normal' as const,
  },
  {
    name: 'Geist Symbols',
    data: readFileSync(join(process.cwd(), 'lib/og/fonts/geist-symbols-400.ttf')),
    weight: 400 as const,
    style: 'normal' as const,
  },
];
