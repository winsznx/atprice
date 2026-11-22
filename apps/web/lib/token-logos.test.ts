import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_MARKETS } from '@atprice/core';
import { describe, expect, it } from 'vitest';
import { BCH_ASSET, tokenLogoSrc } from './token-logos';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

describe('vendored token logos (DD 12)', () => {
  it('has a served file for BCH and every supported market on both networks', () => {
    const assets = [
      BCH_ASSET,
      ...Object.values(SUPPORTED_MARKETS)
        .flat()
        .map((market) => market.tokenCategory),
    ];
    for (const asset of assets) {
      const src = tokenLogoSrc(asset);
      expect(src, asset).toBe(`/tokens/${asset}.svg`);
      expect(existsSync(`${publicDir}${src ?? ''}`), asset).toBe(true);
    }
  });

  it('has no logo for a category outside the map', () => {
    expect(tokenLogoSrc('ab'.repeat(32))).toBeUndefined();
  });
});
