import { SUPPORTED_MARKETS, type Network } from '@atprice/core';
import type { Queryable } from './db/pool.js';

/**
 * Mirrors the core allowlist into the `markets` table at boot. Token identity only ever comes from
 * core (architecture.md, supported markets); the table adds observed liquidity and quotes. A market
 * removed from the allowlist stays as a row with `supported = false`.
 */
export const syncMarkets = async (db: Queryable, network: Network): Promise<void> => {
  const markets = SUPPORTED_MARKETS[network];
  for (const market of markets) {
    await db.query(
      `INSERT INTO markets (network, token_id, symbol, name, decimals, metadata_sources, minimum_buy_sats, minimum_sell_tokens, supported)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (network, token_id) DO UPDATE SET
         symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals,
         metadata_sources = EXCLUDED.metadata_sources, minimum_buy_sats = EXCLUDED.minimum_buy_sats,
         minimum_sell_tokens = EXCLUDED.minimum_sell_tokens, supported = true, updated_at = now()`,
      [
        network,
        market.tokenCategory,
        market.symbol,
        market.name,
        market.decimals,
        JSON.stringify(market.metadataSources),
        market.minimumAmount.buy.toString(),
        market.minimumAmount.sell.toString(),
      ],
    );
  }
  await db.query(
    `UPDATE markets SET supported = false, updated_at = now() WHERE network = $1 AND NOT (token_id = ANY($2::text[]))`,
    [network, markets.map((market) => market.tokenCategory)],
  );
};
