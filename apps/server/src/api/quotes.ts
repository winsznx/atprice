import type { CauldronIndexerClient } from '@atprice/chain';
import { DEFAULT_MAX_NETWORK_FEE, SELL_ORDER_SATS, type OrderSide } from '@atprice/core';
import { bestPoolQuote, keeperExecuteFee, CORE_MATHS } from '../pools/quote.js';
import {
  nominationsFromIndexer,
  readLivePools,
  type LivePool,
  type PoolUtxoReader,
} from '../pools/reader.js';

/** Quotes expire after 15 s (architecture.md, API). */
export const QUOTE_TTL_MS = 15_000;
const POOL_CACHE_MS = 5_000;

export interface MarketQuote {
  readonly side: OrderSide;
  readonly amount: string;
  readonly maxNetworkFee: string;
  readonly networkFee: string;
  /** What the pool releases for the order's pinned supply. */
  readonly poolOutput: string;
  /** Buy: token units the recipient gets. Sell: net proceeds in satoshis (PRD 5.3), never the raw minOut. */
  readonly receive: string;
  readonly pool: {
    readonly outpoint: string;
    readonly ownerPkh: string;
    readonly sats: string;
    readonly tokens: string;
    readonly confirmed: boolean;
  };
  readonly poolsConsidered: number;
  readonly calculatedAt: string;
  readonly expiresAt: string;
}

export class NoLiquidityError extends Error {
  readonly reason = 'no_liquidity';
  constructor(tokenId: string) {
    super(`no Cauldron pool can fill this amount of ${tokenId}`);
    this.name = 'NoLiquidityError';
  }
}

/**
 * Indicative executable quotes for the API: pools nominated by the Cauldron indexer, reserves from a
 * fresh read on the API's own Electrum connection, maths from core (best single pool).
 */
export class QuoteService {
  private readonly cache = new Map<string, { at: number; pools: readonly LivePool[] }>();

  constructor(
    private readonly indexer: CauldronIndexerClient,
    private readonly chain: PoolUtxoReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pools(tokenId: string): Promise<readonly LivePool[]> {
    const cached = this.cache.get(tokenId);
    const now = this.now().getTime();
    if (cached !== undefined && now - cached.at < POOL_CACHE_MS) return cached.pools;
    const read = await readLivePools(
      this.chain,
      tokenId,
      nominationsFromIndexer(await this.indexer.activePools(tokenId)),
    );
    this.cache.set(tokenId, { at: now, pools: read.pools });
    return read.pools;
  }

  async quote(
    tokenId: string,
    side: OrderSide,
    amount: bigint,
    maxNetworkFee: bigint = DEFAULT_MAX_NETWORK_FEE,
  ): Promise<MarketQuote> {
    const pools = await this.pools(tokenId);
    const fee = keeperExecuteFee(maxNetworkFee);
    const order =
      side === 'buy'
        ? { side, satoshis: amount + 1000n + maxNetworkFee, tokenAmount: 0n }
        : { side, satoshis: SELL_ORDER_SATS, tokenAmount: amount };
    const best = bestPoolQuote(CORE_MATHS, order, pools, fee);
    if (best === undefined) throw new NoLiquidityError(tokenId);
    const calculatedAt = this.now();
    return {
      side,
      amount: amount.toString(),
      maxNetworkFee: maxNetworkFee.toString(),
      networkFee: fee.toString(),
      poolOutput: best.output.toString(),
      receive: (side === 'buy' ? best.recipientAmount : best.recipientAmount - SELL_ORDER_SATS).toString(),
      pool: {
        outpoint: best.pool.outpoint,
        ownerPkh: best.pool.ownerPkhHex,
        sats: best.pool.reserves.sats.toString(),
        tokens: best.pool.reserves.tokens.toString(),
        confirmed: best.pool.confirmed,
      },
      poolsConsidered: pools.length,
      calculatedAt: calculatedAt.toISOString(),
      expiresAt: new Date(calculatedAt.getTime() + QUOTE_TTL_MS).toISOString(),
    };
  }
}
