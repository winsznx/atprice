import type { Network, OrderSide } from './order.js';
import type { MarketDomain, SupportedMarket } from './support.js';

/**
 * One supported market. Token identity comes only from this list (architecture.md, supported
 * markets): never from the indexer or BCMR at runtime. Changing it needs a deploy. The choice and its
 * sources are recorded in DECISIONS.md D-014.
 */
export interface MarketDefinition extends SupportedMarket {
  readonly symbol: string;
  readonly name: string;
  /** Display decimals: one token equals `10 ** decimals` base units. */
  readonly decimals: number;
  /** Where the category ID and decimals were verified. */
  readonly metadataSources: readonly string[];
}

const PUSD_MAINNET: MarketDefinition = {
  tokenCategory: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
  symbol: 'PUSD',
  name: 'ParyonUSD',
  decimals: 2,
  minimumAmount: { buy: 50_000n, sell: 10n },
  metadataSources: [
    'https://indexer.riften.net/cauldron/tokens/list_cached (BCMR source onchain, hash verified)',
    'https://bcmr.paytaca.com/api/tokens/2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544/',
    'https://paryonusd.com/',
  ],
};

const RES_MAINNET: MarketDefinition = {
  tokenCategory: '5e4a058f6593be30090ce6e03282ab0a85ad393275f246c2fb34fae15da017da',
  symbol: 'RES',
  name: 'Real Estate Superstable',
  decimals: 6,
  minimumAmount: { buy: 50_000n, sell: 100_000n },
  metadataSources: [
    'https://indexer.riften.net/cauldron/tokens/list_cached (BCMR source onchain, hash verified)',
    'https://bcmr.paytaca.com/api/tokens/5e4a058f6593be30090ce6e03282ab0a85ad393275f246c2fb34fae15da017da/',
    'https://res.cash/',
  ],
};

const PUSDTEST_CHIPNET: MarketDefinition = {
  tokenCategory: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
  symbol: 'PUSDTEST',
  name: 'ParyonUSD (chipnet-16)',
  decimals: 2,
  minimumAmount: { buy: 50_000n, sell: 10n },
  metadataSources: ['https://indexer-chipnet.riften.net/cauldron/tokens/list_cached'],
};

export const SUPPORTED_MARKETS: Readonly<Record<Network, readonly MarketDefinition[]>> = {
  mainnet: [PUSD_MAINNET, RES_MAINNET],
  chipnet: [PUSDTEST_CHIPNET],
};

/** The allowlist of `network` in the shape the shared order-support validator takes. */
export const marketDomain = (network: Network): MarketDomain => ({ markets: SUPPORTED_MARKETS[network] });

export const supportedTokenCategories = (network: Network): readonly string[] =>
  SUPPORTED_MARKETS[network].map((market) => market.tokenCategory);

export const findMarket = (network: Network, tokenCategory: string): MarketDefinition | undefined =>
  SUPPORTED_MARKETS[network].find((market) => market.tokenCategory === tokenCategory);

export const marketMinimum = (market: SupportedMarket, side: OrderSide): bigint => market.minimumAmount[side];
