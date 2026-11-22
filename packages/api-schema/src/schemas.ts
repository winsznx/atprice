import { ORDER_STATUSES } from '@atprice/core';
import { z } from 'zod';
import { positiveAmount, signedAmount, unsignedAmount } from './decimal.js';

/*
 * Response schemas for every endpoint in architecture.md r5 "API". Field lists follow the screen
 * specs' "Data sources" tables and DD 10.3. Amounts are decimal strings parsed to bigint; the server
 * sends null (with a reason) for data it does not have, never 0. Unknown keys are dropped, so the
 * server may add fields without breaking this build; a missing or mistyped field is API_RESPONSE_INVALID.
 */

const hex = (bytes?: number) =>
  z
    .string()
    .regex(
      bytes === undefined ? /^([0-9a-f]{2})*$/ : new RegExp(`^[0-9a-f]{${bytes * 2}}$`),
      'expected lowercase hex',
    );

export const txidSchema = hex(32);
export const tokenCategorySchema = hex(32);
export const keyHashSchema = hex(20);
export const timestampSchema = z.iso.datetime({ offset: true });
export const networkSchema = z.enum(['mainnet', 'chipnet']);
export const sideSchema = z.enum(['buy', 'sell']);
export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const outpointSchema = z.object({ txid: txidSchema, vout: z.number().int().nonnegative() });
export type Outpoint = z.infer<typeof outpointSchema>;

/** Satoshis per token base unit, the `@atprice/core` `PriceRatio` orientation. */
export const ratioSchema = z.object({ numerator: unsignedAmount, denominator: positiveAmount });
export type Ratio = z.infer<typeof ratioSchema>;

export const signedRatioSchema = z.object({ numerator: signedAmount, denominator: positiveAmount });
export type SignedRatio = z.infer<typeof signedRatioSchema>;

/** A value the server either observed or explains the absence of (markets.md "Field rules"). */
const observed = <T extends z.ZodType>(value: T) =>
  z.union([
    z.object({ value, reason: z.null().optional() }),
    z.object({ value: z.null(), reason: z.string().min(1) }),
  ]);

/** The API's error body (`apps/server` `sendError` and its rate limiter): `{ error: "<code>", message }`. */
export const errorEnvelopeSchema = z.object({ error: z.string().min(1), message: z.string() });

// GET /network

export const networkStatusSchema = z.object({
  network: networkSchema,
  genesisHash: hex(32),
  tip: z
    .object({ height: z.number().int().nonnegative(), hash: hex(32), observedAt: timestampSchema })
    .nullable(),
  /** Funding fee rate the browser builds with (DD 7.4). */
  feeRateSatsPerByte: positiveAmount,
  /** DD 7.4 "AtPrice protocol fee": read, never hardcoded, so the page can't disagree with the server. */
  protocolFeeBps: z.number().int().nonnegative(),
  metrics: z
    .object({
      openOrders: z.number().int().nonnegative(),
      executableBacklog: z.number().int().nonnegative(),
      oldestExecutableAgeSeconds: z.number().int().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
});
export type NetworkStatus = z.infer<typeof networkStatusSchema>;

// GET /health (200 ok or 503 degraded; both are answers)

export const HEALTH_REASONS = [
  'tip_lag',
  'sweep_stale',
  'pool_data_stale',
  'subscriptions_incomplete',
  'executable_unfilled',
  'vm_rejected',
  'quote_disagreement',
] as const;

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checkedAt: timestampSchema,
  reasons: z.array(z.union([z.enum(HEALTH_REASONS), z.string().min(1)])),
  sweepIntervalMs: z.number().int().positive(),
  lastSweepFinishedAt: timestampSchema.nullable(),
});
export type Health = z.infer<typeof healthSchema>;

// GET /markets, GET /markets/:tokenId

export const availabilitySchema = z.enum(['open', 'low_liquidity', 'paused']);
export type Availability = z.infer<typeof availabilitySchema>;

export const marketSummarySchema = z.object({
  slug: z.string().min(1),
  tokenId: tokenCategorySchema,
  symbol: z.string().min(1),
  name: z.string(),
  decimals: z.number().int().min(0).max(18),
  verified: z.boolean(),
  spotRate: observed(ratioSchema),
  change24h: observed(signedRatioSchema),
  liquidity: z.object({ sats: unsignedAmount, tokens: unsignedAmount }),
  poolCount: z.number().int().nonnegative(),
  volume24h: observed(z.object({ sats: unsignedAmount, source: z.string().min(1) })),
  availability: availabilitySchema,
  availabilityReason: z.string().nullable(),
  minOrder: z.object({ buy: unsignedAmount, sell: unsignedAmount }),
  observedAt: timestampSchema.nullable(),
  blockHeight: z.number().int().nonnegative().nullable(),
});
export type MarketSummary = z.infer<typeof marketSummarySchema>;

export const marketsSchema = z.object({ markets: z.array(marketSummarySchema) });

export const poolSchema = z.object({
  outpoint: outpointSchema,
  ownerPkh: keyHashSchema,
  sats: unsignedAmount,
  tokens: unsignedAmount,
  spotRate: ratioSchema,
  lastSeenHeight: z.number().int().nonnegative().nullable(),
});
export type Pool = z.infer<typeof poolSchema>;

export const marketDetailSchema = marketSummarySchema.extend({
  verificationSources: z.array(z.string()),
  pools: z.array(poolSchema),
});
export type MarketDetail = z.infer<typeof marketDetailSchema>;

// GET /markets/:tokenId/quote?side&amount

export const quoteSchema = z.object({
  side: sideSchema,
  /** Buy: satoshis spent. Sell: token units sold. */
  amountIn: positiveAmount,
  /** Buy: token units received. Sell: net BCH proceeds in satoshis (DD 4.1 basis). */
  amountOut: unsignedAmount,
  effectiveRate: ratioSchema,
  /** Price impact as a non-negative ratio (0.0042 = 0.42%). */
  priceImpact: ratioSchema,
  pool: z.object({ outpoint: outpointSchema, ownerPkh: keyHashSchema }),
  poolsChecked: z.number().int().nonnegative(),
  blockHeight: z.number().int().nonnegative(),
  calculatedAt: timestampSchema,
  expiresAt: timestampSchema,
});
export type Quote = z.infer<typeof quoteSchema>;

// POST /orders/intents, POST /orders/register

export const intentSchema = z.object({
  intentId: z.string().min(1),
  /** The server's re-derived contract address; the browser compares it with its own (DD 7.2 d). */
  orderAddress: z.string().min(1),
  expiresAt: timestampSchema,
});
export type Intent = z.infer<typeof intentSchema>;

export const registrationSchema = z.object({
  orderId: z.string().min(1),
  status: orderStatusSchema,
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
});
export type Registration = z.infer<typeof registrationSchema>;

// Orders

export const transactionEventSchema = z.object({
  txid: txidSchema,
  kind: z.enum(['funding', 'execute', 'cancel', 'unknown_spend']),
  firstSeenAt: timestampSchema,
  confirmations: z.number().int().nonnegative(),
  blockHeight: z.number().int().nonnegative().nullable(),
  blockHash: hex(32).nullable(),
  networkState: z.enum(['seen', 'confirmed', 'conflicted', 'replaced']),
  conflict: z.string().nullable(),
});
export type TransactionEvent = z.infer<typeof transactionEventSchema>;

export const keeperCheckSchema = z.object({
  checkedAt: timestampSchema,
  poolOutpoint: outpointSchema.nullable(),
  /** The best pool's output for the whole order, in the order's output unit. */
  bestOutput: unsignedAmount.nullable(),
  outcome: z.string().min(1),
});
export type KeeperCheck = z.infer<typeof keeperCheckSchema>;

export const fillSettlementSchema = z.object({
  kind: z.literal('fill'),
  txid: txidSchema,
  blockHeight: z.number().int().nonnegative().nullable(),
  confirmations: z.number().int().nonnegative(),
  /** Buy: token units in the payout. Sell: the payout output in satoshis (proceeds + 2,000 sat reserve). */
  received: unsignedAmount,
  /** Amount above `minOut`, as the contract measures it (DD 7.7 "Above your minimum"). */
  surplus: unsignedAmount,
  poolOutpoint: outpointSchema,
  poolPkh: keyHashSchema,
  poolFeeSats: unsignedAmount,
  networkFeeSats: unsignedAmount,
  filledBy: z.enum(['atprice_keeper', 'other']),
});

export const cancelSettlementSchema = z.object({
  kind: z.literal('cancel'),
  txid: txidSchema,
  blockHeight: z.number().int().nonnegative().nullable(),
  confirmations: z.number().int().nonnegative(),
  refundSats: unsignedAmount,
  refundTokens: unsignedAmount,
  networkFeeSats: unsignedAmount,
  refundAddress: z.string().min(1),
  authorizedBy: z.enum(['cancel', 'cancel_with_sig']),
});

export const settlementSchema = z.discriminatedUnion('kind', [fillSettlementSchema, cancelSettlementSchema]);
export type Settlement = z.infer<typeof settlementSchema>;
export type FillSettlement = z.infer<typeof fillSettlementSchema>;
export type CancelSettlement = z.infer<typeof cancelSettlementSchema>;

export const orderSchema = z.object({
  /** `txid:vout` of the funding outpoint (architecture.md "API"). */
  id: z.string().min(1),
  funding: outpointSchema,
  tokenCategory: tokenCategorySchema,
  side: sideSchema,
  /** Buy: satoshis to spend. Sell: token units to sell. */
  amount: positiveAmount,
  minOut: positiveAmount,
  maxNetworkFee: positiveAmount,
  ownerPkh: keyHashSchema,
  /** The decoded on-chain recipient (order-detail.md: only as part of the decoded record). */
  recipientAddress: z.string().min(1),
  contractVersion: z.number().int().positive(),
  contractAddress: z.string().min(1),
  status: orderStatusSchema,
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  events: z.array(transactionEventSchema),
  keeperCheck: keeperCheckSchema.nullable(),
  settlement: settlementSchema.nullable(),
});
export type Order = z.infer<typeof orderSchema>;

export const orderListSchema = z.object({ orders: z.array(orderSchema) });

export const cancelPrepareSchema = z.object({
  unsignedHex: hex(),
  feeSats: unsignedAmount,
});
export type CancelPrepare = z.infer<typeof cancelPrepareSchema>;

// Executions

export const ATTEMPT_OUTCOMES = [
  'pool_changed',
  'vm_rejected',
  'broadcast_rejected',
  'order_spent',
  'pool_spent',
  'broadcast_ok',
  'dropped',
] as const;

export const attemptSchema = z.object({
  id: z.string().min(1),
  createdAt: timestampSchema,
  outcome: z.enum(ATTEMPT_OUTCOMES),
  reason: z.string().nullable(),
  txid: txidSchema.nullable(),
  poolOutpoint: outpointSchema.nullable(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const executionSchema = fillSettlementSchema.omit({ kind: true }).extend({
  orderId: z.string().min(1),
  side: sideSchema,
  amountIn: positiveAmount,
  observedAt: timestampSchema,
});
export type Execution = z.infer<typeof executionSchema>;

export const orderExecutionsSchema = z.object({
  attempts: z.array(attemptSchema),
  execution: executionSchema.nullable(),
});
export type OrderExecutions = z.infer<typeof orderExecutionsSchema>;

// GET /evidence

export const evidenceSchema = z.object({
  orders: z.array(
    orderSchema.extend({
      settlement: settlementSchema,
      fundingBlock: z.object({ height: z.number().int().nonnegative(), time: timestampSchema }),
      settlementBlock: z.object({ height: z.number().int().nonnegative(), time: timestampSchema }),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceOrder = Evidence['orders'][number];
