import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash256, binToHex } from '@bitauth/libauth';
import { compileFile } from 'cashc';
import { describe, expect, it } from 'vitest';
import { orderArtifact, orderRedeemScript } from '@atprice/core';
import { AtPriceBuyArtifact as DistBuy, AtPriceSellArtifact as DistSell } from '../../dist/index.js';
import { AtPriceBuyArtifact as SrcBuy, AtPriceSellArtifact as SrcSell } from '../../src/index.js';
import { Chain, orderParams } from '../harness.js';

const pathIn = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

/**
 * Every adversarial test runs against whatever artifact `@atprice/core` imports (the built
 * `dist` of this package). This proves that artifact is exactly what cashc 0.14.0 produces from
 * the reviewed `.cash` sources, so the suite attacks the real covenant.
 */
describe('adversarial: the attacked artifact is the reviewed source', () => {
  it.each([
    ['AtPriceBuy', DistBuy, SrcBuy, 'buy'],
    ['AtPriceSell', DistSell, SrcSell, 'sell'],
  ] as const)(
    '%s: fresh cashc compile == artifacts/*.json == src/artifacts.ts == dist == what core uses',
    (name, dist, src, side) => {
      const fresh = compileFile(pathIn(`src/${name}.cash`));
      const json = JSON.parse(readFileSync(pathIn(`artifacts/${name}.json`), 'utf8')) as { bytecode: string };
      expect(json.bytecode).toBe(fresh.bytecode);
      expect(src.bytecode).toBe(fresh.bytecode);
      expect(dist.bytecode).toBe(fresh.bytecode);
      expect(orderArtifact(side).bytecode).toBe(fresh.bytecode);
    },
  );

  it.each(['buy', 'sell'] as const)(
    '%s: the instantiated contract locks to hash256 of core.orderRedeemScript',
    (side) => {
      const chain = new Chain();
      const { order } = chain.addOrder(orderParams(side), { satoshis: 10_000n });
      expect(order.contract.lockingBytecode).toBe(
        `aa20${binToHex(hash256(orderRedeemScript(order.params)))}87`,
      );
    },
  );
});
