import type { Availability, EvidenceOrder, Health, MarketDetail, MarketSummary, SignedRatio } from '@/lib/api/schemas';
import { formatBch, formatPercent, formatToken, orientRate } from '@/lib/format';
import { marketOf, orderInputText, receivedText } from '@/lib/orders/display';

/** Columns a visitor can sort by (markets.md "Controls"); rate, volume and availability are not comparable. */
export const SORT_KEYS = ['liquidity', 'change', 'pair'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';
export interface MarketSort {
  readonly key: SortKey;
  readonly dir: SortDir;
}

export const DEFAULT_SORT: MarketSort = { key: 'liquidity', dir: 'desc' };

/** The direction a column starts in when it becomes the active sort. */
export const initialDir = (key: SortKey): SortDir => (key === 'pair' ? 'asc' : 'desc');

const isSortKey = (value: string | null | undefined): value is SortKey =>
  value !== null && value !== undefined && (SORT_KEYS as readonly string[]).includes(value);

/** `?sort=liquidity|change|pair&dir=asc|desc`; anything else falls back to the default, never throws. */
export const parseSort = (sort: string | null | undefined, dir: string | null | undefined): MarketSort => {
  const key = isSortKey(sort) ? sort : DEFAULT_SORT.key;
  const direction = dir === 'asc' || dir === 'desc' ? dir : isSortKey(sort) ? initialDir(key) : DEFAULT_SORT.dir;
  return { key, dir: direction };
};

/** Clicking the active column flips it; clicking another starts that column in its natural direction. */
export const nextSort = (current: MarketSort, key: SortKey): MarketSort =>
  current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: initialDir(key) };

export const sortSearch = (sort: MarketSort): string => `?sort=${sort.key}&dir=${sort.dir}`;

const SORT_NOUN: Readonly<Record<SortKey, string>> = {
  liquidity: 'liquidity',
  change: '24h change',
  pair: 'pair',
};

export const sortCaption = (sort: MarketSort): string =>
  `Markets on AtPrice, sorted by ${SORT_NOUN[sort.key]}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`;

const compareRatios = (a: SignedRatio, b: SignedRatio): number => {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left === right ? 0 : left < right ? -1 : 1;
};

const compareBigints = (a: bigint, b: bigint): number => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Sorts a copy. Liquidity compares the BCH side, the one unit every market shares. A null 24h change
 * sorts last in both directions (markets.md "Controls"). Ties keep the pair order so rows never jump.
 */
export const sortMarkets = (markets: readonly MarketSummary[], sort: MarketSort): MarketSummary[] => {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const byPair = (a: MarketSummary, b: MarketSummary) => a.symbol.localeCompare(b.symbol, 'en');
  return [...markets].sort((a, b) => {
    if (sort.key === 'change') {
      const left = a.change24h.value;
      const right = b.change24h.value;
      if (left === null || right === null) {
        if (left === right) return byPair(a, b);
        return left === null ? 1 : -1;
      }
      return sign * compareRatios(left, right) || byPair(a, b);
    }
    if (sort.key === 'liquidity') {
      return sign * compareBigints(a.liquidity.sats, b.liquidity.sats) || byPair(a, b);
    }
    return sign * byPair(a, b);
  });
};

export const SYMBOL_DISPLAY_MAX = 12;

/** DD 7.15: symbols are cut at 12 characters; the caller keeps the full symbol in the accessible name. */
export const shortSymbol = (symbol: string): string =>
  symbol.length <= SYMBOL_DISPLAY_MAX ? symbol : `${symbol.slice(0, SYMBOL_DISPLAY_MAX)}…`;

export const pairText = (symbol: string): string => `BCH / ${shortSymbol(symbol)}`;

/** `bch-pusd` style links go through the API's slug; this builds the market detail path from it. */
export const marketPath = (slug: string): string => `/markets/${encodeURIComponent(slug)}`;
export const tradePath = (slug: string, side?: 'buy' | 'sell'): string =>
  `/trade/${encodeURIComponent(slug)}${side === undefined ? '' : `?side=${side}`}`;

export interface AvailabilityDisplay {
  readonly availability: Availability;
  readonly label: string;
  readonly reason: string | null;
}

const AVAILABILITY_LABEL: Readonly<Record<Availability, string>> = {
  open: 'Orders open',
  low_liquidity: 'Low liquidity',
  paused: 'Paused',
};

/**
 * The badge a market shows. A web/API network mismatch overrides the API's own verdict, because the
 * page can't trust that the market belongs to the network it claims (markets.md "Network mismatch").
 */
export const availabilityOf = (
  market: Pick<MarketSummary, 'availability' | 'availabilityReason'>,
  networkMismatch: boolean,
): AvailabilityDisplay => {
  if (networkMismatch) return { availability: 'paused', label: 'Paused', reason: 'Network mismatch' };
  return {
    availability: market.availability,
    label: AVAILABILITY_LABEL[market.availability],
    reason: market.availabilityReason,
  };
};

/** Spot rate as an exact `tokens per BCH` ratio, or null when the API has none. */
export const tokensPerBch = (
  rate: MarketSummary['spotRate'],
  decimals: number,
): { numerator: bigint; denominator: bigint } | null => {
  if (rate.value === null || rate.value.numerator === 0n) return null;
  return orientRate(rate.value, decimals, 'tokens_per_bch');
};

export interface ChangeDisplay {
  readonly direction: 'up' | 'down' | 'flat' | 'none';
  /** `+0.42%`, or `24h change not yet` when the API has fewer than 24 hours of snapshots. */
  readonly text: string;
  readonly spoken: string;
}

export const changeOf = (change: MarketSummary['change24h']): ChangeDisplay => {
  if (change.value === null) {
    return {
      direction: 'none',
      text: '24h change not yet',
      spoken: `24 hour change not available: ${change.reason}`,
    };
  }
  const { numerator, denominator } = change.value;
  const text = formatPercent(numerator, denominator, { signed: true });
  if (numerator === 0n) return { direction: 'flat', text: '0.00%', spoken: 'unchanged in 24 hours' };
  const magnitude = formatPercent(numerator < 0n ? -numerator : numerator, denominator).replace('%', '');
  const direction = numerator > 0n ? 'up' : 'down';
  return { direction, text, spoken: `${direction} ${magnitude} percent in 24 hours` };
};

export const liquidityExact = (market: Pick<MarketSummary, 'liquidity' | 'decimals' | 'symbol'>): string =>
  `${formatToken(market.liquidity.tokens, market.decimals, 'compact')} ${market.symbol} and ${formatBch(market.liquidity.sats, 'compact')} BCH`;

/** The latest observation across markets, for the `Data observed {time}, block {height}` subline. */
export const latestObservation = (
  markets: readonly Pick<MarketSummary, 'observedAt' | 'blockHeight'>[],
): { observedAt: string; blockHeight: number | null } | null => {
  let latest: { observedAt: string; blockHeight: number | null } | null = null;
  for (const market of markets) {
    if (market.observedAt === null) continue;
    if (latest === null || Date.parse(market.observedAt) > Date.parse(latest.observedAt)) {
      latest = { observedAt: market.observedAt, blockHeight: market.blockHeight };
    }
  }
  return latest;
};

/** The oldest observation, which is what a staleness warning must speak for. */
export const oldestObservation = (
  markets: readonly Pick<MarketSummary, 'observedAt'>[],
): string | null => {
  let oldest: string | null = null;
  for (const market of markets) {
    if (market.observedAt === null) continue;
    if (oldest === null || Date.parse(market.observedAt) < Date.parse(oldest)) oldest = market.observedAt;
  }
  return oldest;
};

/** The hostnames a token's identity was verified against, for `verified via {source}`. */
export const sourceHosts = (sources: readonly string[]): string[] => {
  const hosts: string[] = [];
  for (const source of sources) {
    const candidate = source.split(' ')[0] ?? source;
    let host: string;
    try {
      host = new URL(candidate).hostname;
    } catch {
      host = candidate;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
};

/** True when the API's own health verdict says pool data is stale (architecture.md health reasons). */
export const poolDataStale = (health: Health | undefined): boolean =>
  health?.reasons.includes('pool_data_stale') ?? false;

const ACTIVITY_LIMIT = 10;

/** One market's identity: the bundled allowlist first (architecture.md "Supported markets"), then the API. */
export interface MarketIdentity {
  readonly slug: string;
  readonly tokenId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly sources: readonly string[];
}

export const identityOf = (
  market: Pick<MarketSummary, 'slug' | 'tokenId' | 'symbol' | 'name' | 'decimals'> &
    Partial<Pick<MarketDetail, 'verificationSources'>>,
): MarketIdentity => {
  const bundled = marketOf(market.tokenId);
  return {
    slug: market.slug,
    tokenId: market.tokenId,
    symbol: bundled?.symbol ?? market.symbol,
    name: bundled?.name ?? market.name,
    decimals: bundled?.decimals ?? market.decimals,
    sources:
      market.verificationSources !== undefined && market.verificationSources.length > 0
        ? market.verificationSources
        : (bundled?.metadataSources ?? []),
  };
};

export type ActivityKind = 'Funding' | 'Fill' | 'Cancel';

export interface ActivityRow {
  readonly key: string;
  readonly kind: ActivityKind;
  readonly txid: string;
  readonly time: string;
  readonly order: EvidenceOrder;
}

/**
 * Recent AtPrice transactions in one market, from completed orders in `GET /evidence`: each order's
 * settlement and its funding, newest first. Orders still open aren't in evidence, so their funding
 * isn't listed; the block says so.
 */
export const marketActivity = (orders: readonly EvidenceOrder[], tokenId: string, limit = ACTIVITY_LIMIT): ActivityRow[] =>
  orders
    .filter((order) => order.tokenCategory === tokenId)
    .flatMap((order): ActivityRow[] => [
      {
        key: `${order.settlement.txid}-settlement`,
        kind: order.settlement.kind === 'fill' ? 'Fill' : 'Cancel',
        txid: order.settlement.txid,
        time: order.settlementBlock.time,
        order,
      },
      {
        key: `${order.funding.txid}-funding`,
        kind: 'Funding',
        txid: order.funding.txid,
        time: order.fundingBlock.time,
        order,
      },
    ])
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, limit);

/** `Buy 0.05 BCH → 22.61 PUSD` for a fill; the order's input and its refund for a cancel. */
export const activityAmounts = (row: ActivityRow): { from: string; to: string | null } => {
  const { order } = row;
  const side = order.side === 'buy' ? 'Buy' : 'Sell';
  const from = `${side} ${orderInputText(order, 'compact')}`;
  if (row.kind === 'Funding') return { from, to: null };
  if (order.settlement.kind === 'fill') return { from, to: receivedText(order, order.settlement.received, 'compact') };
  return { from, to: `refunded ${formatBch(order.settlement.refundSats, 'compact')} BCH` };
};
