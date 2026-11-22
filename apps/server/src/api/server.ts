import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  binToHex,
  cashAddressToLockingBytecode,
  hexToBin,
  isPayToPublicKeyHash,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { NetworkProvider } from 'cashscript';
import { CHAIN_NETWORKS, explorerLinks } from '@atprice/chain';
import {
  InvalidOrderParamsError,
  OwnerUtxoRequiredError,
  SUPPORTED_MARKETS,
  TransactionBuildError,
  assessFunding,
  buildCancelTransaction,
  MIN_RELAY_FEE_PER_BYTE,
  findMarket,
  instantiateOrder,
  isTerminalStatus,
  marketMinimum,
  orderAddresses,
  orderFunding,
  supportedTokenCategories,
  validateOrderParams,
  type Network,
  type OrderParams,
} from '@atprice/core';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Analytics } from '../analytics.js';
import type { Db } from '../db/pool.js';
import { FACT, readFacts } from '../facts.js';
import { loadHealth } from '../health/load.js';
import { clientPrefix, truncateIp } from '../logger.js';
import { CASH_PREFIX, paramsFromRow, paramsToJson, type OrderRow } from '../orders/model.js';
import type { ChainReader, OrderObserver } from '../orders/observe.js';
import { syncOrderAddress } from '../orders/sync.js';
import type { TrustProxy } from '../env.js';
import { INTENT_TTL_MS, storeIntent } from '../intent-store.js';
import { NoLiquidityError, type QuoteService } from './quotes.js';
import {
  cancelPrepareBodySchema,
  evidenceQuerySchema,
  executionIdParamsSchema,
  intentBodySchema,
  orderIdParamsSchema,
  ordersQuerySchema,
  quoteQuerySchema,
  registerBodySchema,
  tokenParamsSchema,
} from './schemas.js';
import {
  attemptContract,
  blockTimes,
  executionContract,
  ordersContract,
  recordedTip,
  type OrderContract,
} from './contract.js';
import { attemptJson, executionJson, orderJson, type AttemptRow, type ExecutionRow } from './serialize.js';

export interface ApiContext {
  readonly db: Db;
  readonly network: Network;
  readonly webOrigin: string;
  readonly trustProxy: TrustProxy;
  readonly sweepIntervalMs: number;
  readonly evalIntervalMs: number;
  readonly chain: ChainReader & {
    readonly connected: boolean;
    readonly endpoint: { readonly host: string } | undefined;
  };
  readonly observer: OrderObserver;
  readonly provider: NetworkProvider;
  readonly quotes: QuoteService;
  readonly logger: Logger;
  readonly analytics: Analytics;
  readonly now?: () => Date;
  /** Rate limits; tests lower or raise them. */
  readonly limits?: { readonly perMinute: number; readonly writesPerMinute: number };
}

export { INTENTS_PER_CLIENT_PER_HOUR, LIVE_INTENTS_GLOBAL, INTENT_TTL_MS } from '../intent-store.js';
const REGISTER_CACHE_MS = 60_000;
/** DD 7.4: AtPrice charges no protocol fee; the page reads this instead of hardcoding it. */
const PROTOCOL_FEE_BPS = 0;
const BODY_LIMIT_BYTES = 16 * 1024;

const sendError = (
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
) => reply.status(status).send({ error, message, ...extra });

const parse = <T extends z.ZodType>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
): z.infer<T> | undefined => {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  void sendError(reply, 400, 'invalid_request', 'the request does not match the schema', {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
  return undefined;
};

const isMissingTransaction = (error: unknown): boolean =>
  error instanceof Error &&
  /no such mempool or blockchain transaction|not found|unknown transaction/i.test(error.message);

const normalizeOwnerAddress = (address: string, network: Network): string | undefined => {
  const decoded = cashAddressToLockingBytecode(address);
  if (
    typeof decoded === 'string' ||
    decoded.prefix !== CASH_PREFIX[network] ||
    !isPayToPublicKeyHash(decoded.bytecode)
  )
    return undefined;
  const encoded = lockingBytecodeToCashAddress({ bytecode: decoded.bytecode, prefix: CASH_PREFIX[network] });
  return typeof encoded === 'string' ? undefined : encoded.address;
};

/** `false`, the proxy addresses, or "trust the first n hops" as proxy-addr defines a hop count. */
const trustProxyOption = (
  trust: TrustProxy,
): boolean | string[] | ((address: string, hop: number) => boolean) => {
  if (trust === false) return false;
  if (typeof trust === 'number') return (_address, hop) => hop < trust;
  return [...trust];
};

export const buildServer = async (ctx: ApiContext): Promise<FastifyInstance> => {
  const now = ctx.now ?? (() => new Date());
  const loggerInstance: FastifyBaseLogger = ctx.logger;
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trustProxyOption(ctx.trustProxy),
    loggerInstance,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const registerCache = new Map<string, { at: number; orderId: string }>();

  app.addHook('onResponse', async (request, reply) => {
    // No bodies, no query strings (owner addresses), and only the truncated client network.
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        status: reply.statusCode,
        client: truncateIp(request.ip),
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, { origin: ctx.webOrigin, methods: ['GET', 'POST'], maxAge: 600 });
  await app.register(rateLimit, {
    global: true,
    max: ctx.limits?.perMinute ?? 120,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => clientPrefix(request.ip),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `too many requests; retry in ${Math.ceil(context.ttl / 1000)} s`,
    }),
  });
  const writeLimit = { rateLimit: { max: ctx.limits?.writesPerMinute ?? 30, timeWindow: '1 minute' } };

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status === 413)
      return sendError(
        reply,
        413,
        'body_too_large',
        `request bodies are limited to ${BODY_LIMIT_BYTES} bytes`,
      );
    if (status === 429) return reply.status(429).send(error);
    if (status >= 400 && status < 500)
      return sendError(
        reply,
        status,
        'invalid_request',
        error instanceof Error ? error.message : 'bad request',
      );
    request.log.error({ err: error, route: request.routeOptions.url }, 'request failed');
    return sendError(reply, 500, 'internal_error', 'the request failed; it was logged');
  });

  const loadOrder = async (id: string): Promise<OrderRow | undefined> =>
    (await ctx.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND network = $2', [id, ctx.network]))
      .rows[0];
  const contractOrders = (rows: readonly OrderRow[]): Promise<OrderContract[]> =>
    ordersContract(ctx.db, ctx.chain, ctx.network, rows);
  const registration = (row: OrderRow) => ({
    orderId: row.id,
    status: row.status,
    supported: row.supported,
    unsupportedReason: row.unsupported_reason,
    order: orderJson(row),
  });

  const marketJson = async (tokenId: string) => {
    const market = findMarket(ctx.network, tokenId);
    if (market === undefined) return undefined;
    const { rows } = await ctx.db.query<{
      pool_count: number | null;
      liquidity_sats: string | null;
      liquidity_tokens: string | null;
      last_pool_update_at: Date | null;
    }>(
      'SELECT pool_count, liquidity_sats, liquidity_tokens, last_pool_update_at FROM markets WHERE network = $1 AND token_id = $2',
      [ctx.network, tokenId],
    );
    const stats = rows[0];
    const observedAt = stats?.last_pool_update_at ?? null;
    const observed = stats !== undefined && observedAt !== null;
    const poolCount = observed ? (stats.pool_count ?? 0) : 0;
    const sats = observed ? (stats.liquidity_sats ?? '0') : '0';
    const tokens = observed ? (stats.liquidity_tokens ?? '0') : '0';
    return {
      slug: market.symbol.toLowerCase(),
      tokenId: market.tokenCategory,
      symbol: market.symbol,
      name: market.name,
      decimals: market.decimals,
      // Every market is on core's allowlist, each pinned to its verified category and decimals.
      verified: true,
      spotRate:
        observed && BigInt(tokens) > 0n
          ? { value: { numerator: sats, denominator: tokens } }
          : { value: null, reason: observed ? 'no live pool' : 'pool data not observed yet' },
      change24h: { value: null, reason: 'price history is not recorded' },
      poolCount,
      volume24h: { value: null, reason: 'pool volume is not indexed' },
      availability: !observed ? 'paused' : poolCount === 0 ? 'low_liquidity' : 'open',
      availabilityReason: !observed
        ? 'the keeper has not read this market’s pools yet'
        : poolCount === 0
          ? 'no live pool for this token'
          : null,
      minOrder: { buy: market.minimumAmount.buy.toString(), sell: market.minimumAmount.sell.toString() },
      observedAt: observedAt?.toISOString() ?? null,
      blockHeight: await recordedTip(ctx.db, ctx.network),
      minimum: {
        buySatoshis: market.minimumAmount.buy.toString(),
        sellTokenUnits: market.minimumAmount.sell.toString(),
      },
      metadataSources: market.metadataSources,
      liquidity: { sats, tokens },
    };
  };

  await app.register(
    async (api) => {
      api.get('/markets', async () => ({
        network: ctx.network,
        markets: await Promise.all(
          SUPPORTED_MARKETS[ctx.network].map((market) => marketJson(market.tokenCategory)),
        ),
      }));

      api.get('/markets/:tokenId', async (request, reply) => {
        const params = parse(tokenParamsSchema, request.params, reply);
        if (params === undefined) return reply;
        const market = await marketJson(params.tokenId);
        if (market === undefined)
          return sendError(reply, 404, 'market_unsupported', 'this token is not a supported market');
        ctx.analytics.emit('market_viewed', { tokenId: market.tokenId });
        const pools = await ctx.quotes.pools(market.tokenId);
        return {
          ...market,
          verificationSources: market.metadataSources,
          pools: pools
            .filter((pool) => pool.reserves.tokens > 0n)
            .map((pool) => {
              const [txid = '', vout = '0'] = pool.outpoint.split(':');
              return {
                outpoint: { txid, vout: Number(vout) },
                ownerPkh: pool.ownerPkhHex,
                sats: pool.reserves.sats.toString(),
                tokens: pool.reserves.tokens.toString(),
                spotRate: {
                  numerator: pool.reserves.sats.toString(),
                  denominator: pool.reserves.tokens.toString(),
                },
                lastSeenHeight: null,
              };
            }),
        };
      });

      api.get('/markets/:tokenId/quote', async (request, reply) => {
        const params = parse(tokenParamsSchema, request.params, reply);
        const query = parse(quoteQuerySchema, request.query, reply);
        if (params === undefined || query === undefined) return reply;
        if (findMarket(ctx.network, params.tokenId) === undefined) {
          return sendError(reply, 404, 'market_unsupported', 'this token is not a supported market');
        }
        try {
          const quote = await ctx.quotes.quote(
            params.tokenId,
            query.side,
            BigInt(query.amount),
            query.maxNetworkFee === undefined ? undefined : BigInt(query.maxNetworkFee),
          );
          const [poolTxid = '', poolVout = '0'] = quote.pool.outpoint.split(':');
          const amountIn = BigInt(quote.amount);
          const amountOut = BigInt(quote.receive);
          const [satsSide, tokenSide] = quote.side === 'buy' ? [amountIn, amountOut] : [amountOut, amountIn];
          const poolSats = BigInt(quote.pool.sats);
          const poolTokens = BigInt(quote.pool.tokens);
          // |effective - spot| / spot, with both rates as satoshis per token unit.
          const impactNumerator = satsSide * poolTokens - poolSats * tokenSide;
          return {
            ...quote,
            amountIn: quote.amount,
            amountOut: quote.receive,
            effectiveRate: {
              numerator: satsSide.toString(),
              denominator: (tokenSide > 0n ? tokenSide : 1n).toString(),
            },
            priceImpact: {
              numerator: (impactNumerator < 0n ? -impactNumerator : impactNumerator).toString(),
              denominator: (poolSats * (tokenSide > 0n ? tokenSide : 1n)).toString(),
            },
            pool: {
              ...quote.pool,
              outpoint: { txid: poolTxid, vout: Number(poolVout) },
            },
            poolsChecked: quote.poolsConsidered,
            blockHeight: (await ctx.chain.getTip()).height,
          };
        } catch (error) {
          if (error instanceof NoLiquidityError) return sendError(reply, 409, error.reason, error.message);
          throw error;
        }
      });

      api.post('/orders/intents', { config: writeLimit }, async (request, reply) => {
        const body = parse(intentBodySchema, request.body, reply);
        if (body === undefined) return reply;
        const params: OrderParams = {
          side: body.side,
          ownerPkh: hexToBin(body.ownerPkh),
          recipientLockingBytecode: hexToBin(body.recipientLockingBytecode),
          tokenCategory: body.tokenCategory,
          minOut: BigInt(body.minOut),
          maxNetworkFee: BigInt(body.maxNetworkFee),
          nonce: hexToBin(body.nonce),
        };
        const market = findMarket(ctx.network, params.tokenCategory);
        try {
          validateOrderParams(params, { supportedTokenCategories: supportedTokenCategories(ctx.network) });
          if (market === undefined)
            throw new InvalidOrderParamsError('token_category_unsupported', 'not a supported market');
          orderFunding(params, BigInt(body.amount), marketMinimum(market, params.side));
        } catch (error) {
          if (error instanceof InvalidOrderParamsError)
            return sendError(reply, 422, error.reason, error.message);
          throw error;
        }
        const addresses = orderAddresses(params, ctx.network);
        const derived = params.side === 'sell' ? addresses.tokenAddress : addresses.address;
        if (
          body.orderAddress !== derived &&
          body.orderAddress !== addresses.address &&
          body.orderAddress !== addresses.tokenAddress
        ) {
          return sendError(
            reply,
            422,
            'address_mismatch',
            'the server derives a different order address; do not fund',
            {
              serverOrderAddress: derived,
            },
          );
        }
        const stored = await storeIntent(ctx.db, {
          network: ctx.network,
          orderAddress: derived,
          orderLockingBytecode: binToHex(addresses.lockingBytecode),
          side: params.side,
          tokenId: params.tokenCategory,
          amount: body.amount,
          params: paramsToJson(params),
          clientPrefix: clientPrefix(request.ip),
          expiresAt: new Date(now().getTime() + INTENT_TTL_MS),
        });
        if (stored.kind === 'intent_rate_limited') {
          return sendError(
            reply,
            429,
            'intent_rate_limited',
            'too many order intents from this network; register after funding instead',
          );
        }
        if (stored.kind === 'intent_capacity') {
          return sendError(
            reply,
            429,
            'intent_capacity',
            'the intent watch list is full; register after funding instead',
          );
        }
        const { intent } = stored;
        ctx.analytics.emit('order_created', {
          intentId: intent.id,
          side: params.side,
          tokenId: params.tokenCategory,
          amount: body.amount,
        });
        return reply.status(201).send({
          intentId: intent.id,
          status: intent.status,
          orderAddress: derived,
          expiresAt: intent.expires_at.toISOString(),
        });
      });

      api.post('/orders/register', { config: writeLimit }, async (request, reply) => {
        const body = parse(registerBodySchema, request.body, reply);
        if (body === undefined) return reply;
        const cached = registerCache.get(body.txid);
        if (cached !== undefined && now().getTime() - cached.at < REGISTER_CACHE_MS) {
          const row = await loadOrder(cached.orderId);
          if (row !== undefined) return registration(row);
        }
        let transaction;
        try {
          transaction = await ctx.observer.transaction(body.txid);
        } catch (error) {
          if (isMissingTransaction(error))
            return sendError(
              reply,
              404,
              'transaction_not_found',
              'no such transaction in the mempool or chain',
            );
          throw error;
        }
        const funding = assessFunding(transaction, { markets: SUPPORTED_MARKETS[ctx.network] });
        if (funding.params === undefined || funding.fundingVout === undefined) {
          return sendError(
            reply,
            422,
            funding.supported ? 'not_an_order' : funding.reason,
            funding.supported ? 'not an order' : funding.detail,
          );
        }
        const orderId = `${body.txid}:${funding.fundingVout}`;
        // Register only accelerates discovery; a terminal order changes through the keeper alone.
        const stored = await loadOrder(orderId);
        if (stored !== undefined && isTerminalStatus(stored.status)) return registration(stored);
        await syncOrderAddress(ctx.db, ctx.observer, funding.params, {
          sweep: false,
          reason: 'register',
          analytics: ctx.analytics,
        });
        await ctx.db.query(`SELECT pg_notify('order_registered', $1)`, [orderId]);
        const row = await loadOrder(orderId);
        if (row === undefined)
          return sendError(
            reply,
            404,
            'funding_not_observed',
            'the funding output is not in the order address history yet',
          );
        registerCache.set(body.txid, { at: now().getTime(), orderId });
        return registration(row);
      });

      api.get('/orders/:id', async (request, reply) => {
        const params = parse(orderIdParamsSchema, request.params, reply);
        if (params === undefined) return reply;
        const row = await loadOrder(params.id);
        if (row === undefined)
          return sendError(reply, 404, 'order_not_found', 'no order with this funding outpoint');
        const { rows: events } = await ctx.db.query(
          `SELECT id, txid, cause, decision, from_status, to_status, network_state, block_height, block_hash, observed_at
             FROM transaction_events WHERE order_id = $1 ORDER BY id`,
          [row.id],
        );
        const { rows: strays } = await ctx.db.query<OrderRow>(
          'SELECT * FROM orders WHERE parent_order_id = $1 ORDER BY id',
          [row.id],
        );
        const [contract] = await contractOrders([row]);
        return {
          ...contract,
          order: orderJson(row),
          instances: strays.map(orderJson),
          log: events.map((event: Record<string, unknown>) => ({
            id: String(event.id),
            txid: event.txid,
            cause: event.cause,
            decision: event.decision,
            from: event.from_status,
            to: event.to_status,
            networkState: event.network_state,
            blockHeight: event.block_height,
            blockHash: event.block_hash,
            observedAt: (event.observed_at as Date).toISOString(),
          })),
        };
      });

      api.get('/orders', async (request, reply) => {
        const query = parse(ordersQuerySchema, request.query, reply);
        if (query === undefined) return reply;
        let rows: OrderRow[];
        if (query.outpoints !== undefined) {
          rows = (
            await ctx.db.query<OrderRow>(
              'SELECT * FROM orders WHERE network = $1 AND id = ANY($2::text[]) ORDER BY created_at DESC',
              [ctx.network, query.outpoints],
            )
          ).rows;
        } else {
          const address = normalizeOwnerAddress(query.address ?? '', ctx.network);
          if (address === undefined) {
            return sendError(
              reply,
              400,
              'owner_address_invalid',
              `give the exact P2PKH owner address on ${ctx.network}`,
            );
          }
          rows = (
            await ctx.db.query<OrderRow>(
              'SELECT * FROM orders WHERE network = $1 AND owner_address = $2 ORDER BY created_at DESC LIMIT 500',
              [ctx.network, address],
            )
          ).rows;
        }
        return { orders: await contractOrders(rows) };
      });

      api.post('/orders/:id/cancel/prepare', { config: writeLimit }, async (request, reply) => {
        const params = parse(orderIdParamsSchema, request.params, reply);
        const body = parse(cancelPrepareBodySchema, request.body, reply);
        if (params === undefined || body === undefined) return reply;
        const row = await loadOrder(params.id);
        if (row === undefined)
          return sendError(reply, 404, 'order_not_found', 'no order with this funding outpoint');
        if (row.status === 'FILLED' || row.status === 'CANCELLED') {
          return sendError(reply, 409, 'order_terminal', `the order is ${row.status}`);
        }
        const orderParams = paramsFromRow(row);
        const orderUtxo = (await ctx.chain.getUtxos(hexToBin(row.order_locking_bytecode))).find(
          (utxo) => utxo.txid === row.funding_txid && utxo.vout === row.funding_vout,
        );
        if (orderUtxo === undefined)
          return sendError(reply, 409, 'order_spent', 'the order outpoint is already spent');
        const ownerLocking = hexToBin(`76a914${row.owner_pkh}88ac`);
        const ownerUtxos = (await ctx.chain.getUtxos(ownerLocking)).map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis: utxo.satoshis,
          lockingBytecode: binToHex(ownerLocking),
          ...(utxo.token && {
            token: {
              category: utxo.token.category,
              amount: utxo.token.amount,
              ...(utxo.token.nft && { nft: utxo.token.nft }),
            },
          }),
        }));
        try {
          const draft = buildCancelTransaction({
            owner: {
              utxos: ownerUtxos,
              ...(body.addressIndex !== undefined && { addressIndex: body.addressIndex }),
            },
            orders: [
              {
                order: instantiateOrder(orderParams, ctx.provider),
                utxo: {
                  txid: orderUtxo.txid,
                  vout: orderUtxo.vout,
                  satoshis: orderUtxo.satoshis,
                  lockingBytecode: row.order_locking_bytecode,
                  ...(orderUtxo.token && {
                    token: {
                      category: orderUtxo.token.category,
                      amount: orderUtxo.token.amount,
                      ...(orderUtxo.token.nft && { nft: orderUtxo.token.nft }),
                    },
                  }),
                },
              },
            ],
            ...(body.userPrompt !== undefined && { userPrompt: body.userPrompt }),
          });
          ctx.analytics.emit('cancellation_requested', {
            orderId: row.id,
            side: row.side,
            tokenId: row.token_id,
          });
          return {
            orderId: row.id,
            unsignedHex: draft.unsignedHex,
            request: draft.request,
            fee: draft.fee.toString(),
            feeSats: draft.fee.toString(),
            estimatedSize: draft.estimatedSize,
            ownerUtxo: {
              txid: draft.ownerUtxo.txid,
              vout: draft.ownerUtxo.vout,
              satoshis: draft.ownerUtxo.satoshis.toString(),
            },
            note: 'rebuild this cancel locally with @atprice/core and compare before signing',
          };
        } catch (error) {
          if (error instanceof OwnerUtxoRequiredError) {
            return sendError(reply, 409, error.reason, error.message, {
              ownerAddress: row.owner_address,
              requiredSatoshis: error.requiredSatoshis.toString(),
              largestSatoshis: error.largestSatoshis.toString(),
            });
          }
          if (error instanceof TransactionBuildError)
            return sendError(reply, 409, error.reason, error.message);
          throw error;
        }
      });

      api.get('/executions/:id', async (request, reply) => {
        const params = parse(executionIdParamsSchema, request.params, reply);
        if (params === undefined) return reply;
        const column = params.id.includes('-') ? 'id::text' : 'txid';
        const { rows } = await ctx.db.query<ExecutionRow>(
          `SELECT * FROM executions WHERE network = $1 AND ${column} = $2`,
          [ctx.network, params.id],
        );
        const row = rows[0];
        if (row === undefined)
          return sendError(reply, 404, 'execution_not_found', 'no execution with this id');
        return {
          ...executionContract(row, await recordedTip(ctx.db, ctx.network)),
          execution: executionJson(row),
        };
      });

      api.get('/orders/:id/executions', async (request, reply) => {
        const params = parse(orderIdParamsSchema, request.params, reply);
        if (params === undefined) return reply;
        const row = await loadOrder(params.id);
        if (row === undefined)
          return sendError(reply, 404, 'order_not_found', 'no order with this funding outpoint');
        const { rows: executions } = await ctx.db.query<ExecutionRow>(
          'SELECT * FROM executions WHERE order_id = $1 ORDER BY created_at',
          [row.id],
        );
        const { rows: attempts } = await ctx.db.query<AttemptRow>(
          'SELECT * FROM keeper_attempts WHERE order_id = $1 ORDER BY started_at DESC LIMIT 200',
          [row.id],
        );
        const settled =
          executions.find((execution) => execution.txid === row.spend_txid) ?? executions.at(-1);
        return {
          execution:
            settled === undefined ? null : executionContract(settled, await recordedTip(ctx.db, ctx.network)),
          executions: executions.map(executionJson),
          attempts: attempts.map((attempt) => ({
            ...attemptJson(attempt, ctx.network),
            ...attemptContract(attempt),
          })),
        };
      });

      api.get('/evidence', async (request, reply) => {
        const query = parse(evidenceQuerySchema, request.query, reply);
        if (query === undefined) return reply;
        const limit = Math.min(Number(query.limit ?? 100), 200);
        const { rows: fills } = await ctx.db.query<
          ExecutionRow & { funding_txid: string; token_id: string; min_out: string }
        >(
          `SELECT e.*, o.funding_txid, o.token_id, o.min_out FROM executions e JOIN orders o ON o.id = e.order_id
            WHERE e.network = $1 AND e.status = 'confirmed' ORDER BY e.confirmed_at DESC LIMIT $2`,
          [ctx.network, limit],
        );
        const { rows: cancels } = await ctx.db.query<OrderRow>(
          `SELECT * FROM orders WHERE network = $1 AND status = 'CANCELLED' AND spend_height IS NOT NULL ORDER BY updated_at DESC LIMIT $2`,
          [ctx.network, limit],
        );
        const [cursorHeight, cursorTxid, cursorVout] = query.cursor?.split(':') ?? [];
        const { rows: settledRows } = await ctx.db.query<OrderRow>(
          `SELECT o.* FROM orders o
            WHERE o.network = $1 AND o.supported AND o.funding_height IS NOT NULL AND o.spend_height IS NOT NULL
              AND (o.status = 'CANCELLED'
                OR (o.status = 'FILLED' AND EXISTS (
                  SELECT 1 FROM executions e WHERE e.txid = o.spend_txid AND e.status = 'confirmed')))
              AND ($3::integer IS NULL OR (o.spend_height, o.id) < ($3, $4))
            ORDER BY o.spend_height DESC, o.id DESC LIMIT $2`,
          [
            ctx.network,
            limit,
            cursorHeight === undefined ? null : Number(cursorHeight),
            cursorTxid === undefined ? null : `${cursorTxid}:${cursorVout}`,
          ],
        );
        const settled = await contractOrders(settledRows);
        const times = await blockTimes(
          ctx.db,
          ctx.network,
          settledRows.flatMap((row) => [row.funding_txid, row.spend_txid ?? row.funding_txid]),
        );
        const blockOf = (txid: string, height: number, fallback: Date) => ({
          height,
          time: (times.get(txid) ?? fallback).toISOString(),
        });
        const last = settledRows.at(-1);
        const links = explorerLinks(ctx.network);
        return {
          orders: settled.flatMap((order, index) => {
            const row = settledRows[index];
            if (row === undefined || order.settlement === null) return [];
            return [
              {
                ...order,
                settlement: order.settlement,
                fundingBlock: blockOf(row.funding_txid, row.funding_height ?? 0, row.created_at),
                settlementBlock: blockOf(row.spend_txid ?? '', row.spend_height ?? 0, row.updated_at),
              },
            ];
          }),
          nextCursor:
            last === undefined || settledRows.length < limit ? null : `${last.spend_height}:${last.id}`,
          network: ctx.network,
          note: 'every entry is a confirmed on-chain transaction observed by AtPrice; nothing here is simulated',
          fills: fills.map((fill) => ({
            ...executionJson(fill),
            tokenId: fill.token_id,
            minOut: fill.min_out,
            funding: { txid: fill.funding_txid, explorerUrl: links.transaction(fill.funding_txid) },
          })),
          cancels: cancels.map((row) => ({
            orderId: row.id,
            tokenId: row.token_id,
            side: row.side,
            funding: { txid: row.funding_txid, explorerUrl: links.transaction(row.funding_txid) },
            cancel:
              row.spend_txid === null
                ? null
                : {
                    txid: row.spend_txid,
                    blockHeight: row.spend_height,
                    explorerUrl: links.transaction(row.spend_txid),
                  },
          })),
        };
      });

      api.get('/health', async (_request, reply) => {
        const verdict = await loadHealth(
          ctx.db,
          { network: ctx.network, sweepIntervalMs: ctx.sweepIntervalMs, evalIntervalMs: ctx.evalIntervalMs },
          now(),
        );
        return reply.status(verdict.status === 'ok' ? 200 : 503).send({
          ...verdict,
          network: ctx.network,
          checkedAt: now().toISOString(),
          sweepIntervalMs: ctx.sweepIntervalMs,
          lastSweepFinishedAt:
            (await readFacts(ctx.db, ctx.network)).get(FACT.sweep)?.observedAt.toISOString() ?? null,
        });
      });

      api.get('/network', async () => {
        const facts = await readFacts(ctx.db, ctx.network);
        const fact = (name: string) => {
          const value = facts.get(name);
          return value === undefined
            ? null
            : { value: value.value, observedAt: value.observedAt.toISOString() };
        };
        const { rows: metrics } = await ctx.db.query<Record<string, string | Date | null>>(
          `SELECT
             (SELECT count(*) FROM orders WHERE network = $1 AND status = 'OPEN' AND supported) AS open_orders,
             (SELECT count(*) FROM orders WHERE network = $1 AND status = 'RECONCILIATION_REQUIRED') AS reconciliation_required,
             (SELECT count(*) FROM orders WHERE network = $1 AND spend_kind = 'unknown') AS unexpected_spends,
             (SELECT count(*) FROM evaluator_orders WHERE network = $1 AND executable_since IS NOT NULL) AS executable_backlog,
             (SELECT min(executable_since) FROM evaluator_orders WHERE network = $1) AS oldest_executable_since,
             (SELECT count(*) FROM executions WHERE network = $1 AND status = 'confirmed' AND by_atprice_keeper) AS keeper_fills_confirmed`,
          [ctx.network],
        );
        const { rows: outcomes } = await ctx.db.query<{ outcome: string; count: string }>(
          `SELECT outcome, count(*) AS count FROM keeper_attempts
            WHERE network = $1 AND started_at > now() - interval '1 hour' GROUP BY outcome ORDER BY outcome`,
          [ctx.network],
        );
        const { rows: evaluatorTip } = await ctx.db.query<{
          value: { height: number; server: string | null };
        }>(`SELECT value FROM evaluator_state WHERE network = $1 AND name = 'tip'`, [ctx.network]);
        const header = facts.get(FACT.header)?.value as { height?: number } | undefined;
        const independentHeight = evaluatorTip[0]?.value.height;
        const m = metrics[0] ?? {};
        const oldest = m.oldest_executable_since instanceof Date ? m.oldest_executable_since : null;
        const headerFact = facts.get(FACT.header);
        const tipHeader = headerFact?.value as { height?: unknown; hash?: unknown } | undefined;
        return {
          network: ctx.network,
          genesisHash: CHAIN_NETWORKS[ctx.network].genesisHash,
          tip:
            headerFact !== undefined &&
            typeof tipHeader?.height === 'number' &&
            typeof tipHeader.hash === 'string'
              ? {
                  height: tipHeader.height,
                  hash: tipHeader.hash,
                  observedAt: headerFact.observedAt.toISOString(),
                }
              : null,
          feeRateSatsPerByte: MIN_RELAY_FEE_PER_BYTE.toString(),
          protocolFeeBps: PROTOCOL_FEE_BPS,
          blockIntervalSeconds: CHAIN_NETWORKS[ctx.network].blockIntervalSeconds,
          api: { electrumConnected: ctx.chain.connected, electrumServer: ctx.chain.endpoint?.host ?? null },
          keeper: {
            header: fact(FACT.header),
            electrum: fact(FACT.electrum),
            subscriptions: fact(FACT.subscriptions),
            sweep: fact(FACT.sweep),
            lastAttempt: fact(FACT.lastAttempt),
            lastBroadcast: fact(FACT.lastBroadcast),
            lastConfirmedFill: fact(FACT.lastConfirmedFill),
            reactionLatency: fact(FACT.reactionLatency),
          },
          metrics: {
            openOrders: Number(m.open_orders ?? 0),
            executableBacklog: Number(m.executable_backlog ?? 0),
            oldestExecutableAgeSeconds:
              oldest === null ? null : Math.round((now().getTime() - oldest.getTime()) / 1000),
            attemptsLastHour: Object.fromEntries(outcomes.map((row) => [row.outcome, Number(row.count)])),
            keeperFillsConfirmed: Number(m.keeper_fills_confirmed ?? 0),
            reconciliationRequired: Number(m.reconciliation_required ?? 0),
            unexpectedSpends: Number(m.unexpected_spends ?? 0),
            electrumLagBlocks:
              typeof header?.height === 'number' && typeof independentHeight === 'number'
                ? independentHeight - header.height
                : null,
          },
        };
      });
    },
    { prefix: '/api/v1' },
  );

  return app;
};
