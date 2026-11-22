import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BchLogo, PairLogos, TokenLogo } from './token-logo';

const PUSDTEST = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const UNKNOWN = 'ab'.repeat(32);

afterEach(cleanup);

describe('TokenLogo (DD 12)', () => {
  it('renders a known token as its vendored logo, decorative, in a bordered circle', () => {
    const { container } = render(<TokenLogo asset={PUSDTEST} symbol="PUSDTEST" size={20} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`/tokens/${PUSDTEST}.svg`);
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('width')).toBe('20');
    expect(img?.className).toContain('size-5');
    expect(img?.className).toContain('rounded-full');
    expect(img?.className).toContain('ring-border');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders BCH from bch.svg', () => {
    const { container } = render(<BchLogo size={32} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/tokens/bch.svg');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.className).toContain('size-8');
  });

  it('falls back to a neutral two-letter monogram, never another token’s logo', () => {
    const { container } = render(<TokenLogo asset={UNKNOWN} symbol="ZORK" />);
    expect(container.querySelector('img')).toBeNull();
    const monogram = container.firstElementChild;
    expect(monogram?.textContent).toBe('ZO');
    expect(monogram?.getAttribute('title')).toBe('No official logo');
    expect(monogram?.getAttribute('aria-hidden')).toBe('true');
    expect(monogram?.className).toContain('bg-surface-sunken');
    expect(monogram?.className).toContain('font-semibold');
  });

  it('puts the BCH logo first in a pair', () => {
    const { container } = render(<PairLogos tokenCategory={PUSDTEST} symbol="PUSDTEST" />);
    const sources = Array.from(container.querySelectorAll('img'), (img) => img.getAttribute('src'));
    expect(sources).toEqual(['/tokens/bch.svg', `/tokens/${PUSDTEST}.svg`]);
  });
});
