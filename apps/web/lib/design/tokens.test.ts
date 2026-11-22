import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(import.meta.dirname, '..', '..');
const tokens = readFileSync(join(WEB_ROOT, 'app', 'tokens.css'), 'utf8');

const hexToken = (name: string): string => {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(tokens);
  if (match?.[1] === undefined) throw new Error(`token --color-${name} is missing or not a hex value`);
  return match[1];
};

const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(hexToken(a)), luminance(hexToken(b))].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};

/** DD 6, the pairs actually rendered. 4.5 for text, 3 for boundaries, icons and focus (WCAG 2.2 AA). */
const PAIRS: readonly (readonly [string, string, number])[] = [
  ['fg', 'surface', 4.5],
  ['fg-secondary', 'surface-sunken', 4.5],
  ['fg-muted', 'surface', 4.5],
  ['fg-muted', 'surface-sunken', 4.5],
  ['fg-muted', 'surface-muted', 4.5],
  ['fg-muted', 'status-review-subtle', 4.5],
  ['brand-fg', 'brand', 4.5],
  ['brand-fg', 'brand-hover', 4.5],
  ['brand-fg', 'fg-hover', 4.5],
  ['brand-fg', 'status-failed', 4.5],
  ['brand-fg', 'status-failed-hover', 4.5],
  ['link', 'surface', 4.5],
  ['link', 'surface-sunken', 4.5],
  ['status-open', 'status-open-subtle', 4.5],
  ['status-pending', 'status-pending-subtle', 4.5],
  ['status-filled', 'status-filled-subtle', 4.5],
  ['status-cancelled', 'status-cancelled-subtle', 4.5],
  ['status-failed', 'status-failed-subtle', 4.5],
  ['status-review', 'status-review-subtle', 4.5],
  ['buy', 'buy-subtle', 4.5],
  ['sell', 'sell-subtle', 4.5],
  ['banner-fg-muted', 'banner', 4.5],
  ['banner-link', 'banner', 4.5],
  ['banner-chip-fg', 'banner-chip', 4.5],
  ['banner-fg-muted', 'banner-chip-hover', 4.5],
  ['border-input', 'surface', 3],
  ['border-input', 'surface-muted', 3],
  ['focus', 'surface', 3],
  ['focus', 'surface-sunken', 3],
  ['focus-inverse', 'banner', 3],
  ['focus-inverse', 'banner-chip', 3],
  ['banner-chip-border', 'banner', 3],
];

describe('DD 6 contrast table against tokens.css', () => {
  it.each(PAIRS)('%s on %s meets %d:1', (foreground, background, minimum) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });
});

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });

/** motion.md rule 8: every movement class and every non-150 ms duration is gated by motion-safe/-reduce. */
describe('motion.md rule 8 gating', () => {
  const MOVEMENT =
    /(?:^|[\s'"`])((?:[\w-]+(?:\[[^\]]*\])?:)*)(slide-in-from|slide-out-to|zoom-in|zoom-out|\[--tw-enter-|\[--tw-exit-|animate-\[disclosure|duration-)[^\s'"`]*/g;
  it.each(sourceFiles(join(WEB_ROOT, 'components')))('%s gates every movement and duration class', (file) => {
    const source = readFileSync(file, 'utf8');
    const offenders: string[] = [];
    for (const match of source.matchAll(MOVEMENT)) {
      const token = match[0].trim().replace(/^['"`]/, '');
      if (token.endsWith('duration-(--duration-fast)') && !token.includes('motion-')) continue;
      const variants = match[1] ?? '';
      if (!variants.includes('motion-safe:') && !variants.includes('motion-reduce:')) offenders.push(token);
    }
    expect(offenders).toEqual([]);
  });
});
