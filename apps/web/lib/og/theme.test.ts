import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK_SVG, OG_COLOURS, ogToneColours } from './theme';
import { colourToken } from './tokens';

const WEB_ROOT = join(import.meta.dirname, '..', '..');

describe('colourToken', () => {
  it('reads a hex token and refuses one that is missing or not hex', () => {
    const css = '--color-brand: #5531d1;\n  --color-scrim: rgb(16 19 28 / 0.48);';
    expect(colourToken(css, 'brand')).toBe('#5531d1');
    expect(() => colourToken(css, 'scrim')).toThrow(/--color-scrim/);
    expect(() => colourToken(css, 'absent')).toThrow(/--color-absent/);
  });
});

describe('generated image theme', () => {
  it('takes its colours from app/tokens.css', () => {
    const tokens = readFileSync(join(WEB_ROOT, 'app', 'tokens.css'), 'utf8');
    expect(OG_COLOURS.brand).toBe(colourToken(tokens, 'brand'));
    expect(ogToneColours('filled')).toEqual({
      fg: colourToken(tokens, 'status-filled'),
      bg: colourToken(tokens, 'status-filled-subtle'),
    });
  });

  it('renders the favicon, which is byte for byte the design mark', () => {
    const designMark = readFileSync(join(WEB_ROOT, '..', '..', 'docs', 'assets', 'brand', 'mark.svg'), 'utf8');
    expect(MARK_SVG).toBe(designMark);
  });
});
