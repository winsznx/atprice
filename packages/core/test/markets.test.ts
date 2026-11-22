import { describe, expect, it } from 'vitest';
import {
  findMarket,
  isTokenCategoryHex,
  marketDomain,
  SUPPORTED_MARKETS,
  supportedTokenCategories,
} from '../src/index.js';

describe('supported markets', () => {
  it('lists PUSDTEST on chipnet with 2 decimals', () => {
    expect(supportedTokenCategories('chipnet')).toEqual([
      'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
    ]);
    expect(
      findMarket('chipnet', 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b')?.decimals,
    ).toBe(2);
  });

  it('lists PUSD (2 dp) and RES (6 dp) on mainnet and never MUSDv0', () => {
    expect(
      findMarket('mainnet', '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544')?.decimals,
    ).toBe(2);
    expect(
      findMarket('mainnet', '5e4a058f6593be30090ce6e03282ab0a85ad393275f246c2fb34fae15da017da')?.decimals,
    ).toBe(6);
    expect(
      findMarket('mainnet', '4046913cba6b70b2214a048a3df92252849f481ffa1455ed7faf17243c36bf67'),
    ).toBeUndefined();
  });

  it('keeps every entry well formed: display-order hex, positive minimums, cited sources, unique per network', () => {
    for (const markets of Object.values(SUPPORTED_MARKETS)) {
      const categories = markets.map((market) => market.tokenCategory);
      expect(new Set(categories).size).toBe(categories.length);
      for (const market of markets) {
        expect(isTokenCategoryHex(market.tokenCategory)).toBe(true);
        expect(market.minimumAmount.buy > 0n && market.minimumAmount.sell > 0n).toBe(true);
        expect(market.metadataSources.length).toBeGreaterThan(0);
        expect(Number.isInteger(market.decimals) && market.decimals >= 0).toBe(true);
      }
    }
  });

  it('separates networks: a mainnet category is not supported on chipnet', () => {
    expect(marketDomain('chipnet').markets.map((m) => m.tokenCategory)).not.toContain(
      '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
    );
  });
});
