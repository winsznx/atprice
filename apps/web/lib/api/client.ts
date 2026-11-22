import type { OrderSide } from '@atprice/core';
import type { z } from 'zod';
import { publicEnv } from '../env/public';
import { toDecimalString } from './decimal';
import { ApiError } from './errors';
import {
  cancelPrepareSchema,
  errorEnvelopeSchema,
  evidenceSchema,
  executionSchema,
  healthSchema,
  intentSchema,
  marketDetailSchema,
  marketsSchema,
  networkStatusSchema,
  orderExecutionsSchema,
  orderListSchema,
  orderSchema,
  quoteSchema,
  registrationSchema,
  type CancelPrepare,
  type Evidence,
  type Execution,
  type Health,
  type Intent,
  type MarketDetail,
  type MarketSummary,
  type NetworkStatus,
  type Order,
  type OrderExecutions,
  type Outpoint,
  type Quote,
  type Registration,
} from './schemas';

const REQUEST_TIMEOUT_MS = 15_000;

interface RequestOptions<T extends z.ZodType> {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly schema: T;
  readonly signal?: AbortSignal | undefined;
  /** Statuses whose body is a normal answer to parse with `schema`, not an error (health's 503). */
  readonly acceptStatuses?: readonly number[];
}

const buildUrl = (path: string, query: RequestOptions<z.ZodType>['query']): string => {
  const url = new URL(`${publicEnv.apiUrl}/api/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
};

const readJson = async (response: Response, endpoint: string): Promise<unknown> => {
  try {
    return await response.json();
  } catch (cause) {
    throw new ApiError({
      code: 'API_RESPONSE_INVALID',
      endpoint,
      status: response.status,
      message: `AtPrice's server sent a body that is not JSON (HTTP ${response.status}).`,
      cause,
    });
  }
};

async function request<T extends z.ZodType>(options: RequestOptions<T>): Promise<z.output<T>> {
  const method = options.method ?? 'GET';
  const endpoint = `${method} ${options.path}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(buildUrl(options.path, options.query), {
      method,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      headers:
        options.body === undefined
          ? { accept: 'application/json' }
          : {
              accept: 'application/json',
              'content-type': 'application/json',
            },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    const timedOut = timeout.aborted;
    throw new ApiError({
      code: timedOut ? 'API_TIMEOUT' : 'API_UNREACHABLE',
      endpoint,
      message: timedOut
        ? `AtPrice's server didn't answer within ${REQUEST_TIMEOUT_MS / 1000} s.`
        : "AtPrice's server is not responding.",
      cause,
    });
  }

  const json = await readJson(response, endpoint);
  if (!response.ok && !(options.acceptStatuses ?? []).includes(response.status)) {
    const envelope = errorEnvelopeSchema.safeParse(json);
    throw new ApiError({
      code: 'API_ERROR',
      endpoint,
      status: response.status,
      serverCode: envelope.success ? envelope.data.error : null,
      message: envelope.success
        ? envelope.data.message
        : `AtPrice's server answered HTTP ${response.status} without a named reason.`,
    });
  }
  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      code: 'API_RESPONSE_INVALID',
      endpoint,
      status: response.status,
      message: `AtPrice's server sent an answer this page doesn't understand: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}.`,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

const enc = encodeURIComponent;

/** The fields `POST /orders/intents` takes: the browser-derived parameters, hex and decimal strings. */
export interface IntentRequest {
  readonly side: OrderSide;
  readonly ownerPkh: string;
  readonly recipientLockingBytecode: string;
  readonly tokenCategory: string;
  readonly amount: bigint;
  readonly minOut: bigint;
  readonly maxNetworkFee: bigint;
  readonly nonce: string;
  /** The contract address the browser derived; the server re-derives it and refuses a mismatch. */
  readonly orderAddress: string;
}

type Signal = { readonly signal?: AbortSignal | undefined };

/** Typed client for every endpoint in architecture.md r5 "API". Every response is zod-parsed. */
export const api = {
  network: ({ signal }: Signal = {}): Promise<NetworkStatus> =>
    request({ path: '/network', schema: networkStatusSchema, signal }),

  health: ({ signal }: Signal = {}): Promise<Health> =>
    request({ path: '/health', schema: healthSchema, signal, acceptStatuses: [503] }),

  markets: async ({ signal }: Signal = {}): Promise<readonly MarketSummary[]> =>
    (await request({ path: '/markets', schema: marketsSchema, signal })).markets,

  market: (tokenId: string, { signal }: Signal = {}): Promise<MarketDetail> =>
    request({ path: `/markets/${enc(tokenId)}`, schema: marketDetailSchema, signal }),

  quote: (tokenId: string, side: OrderSide, amount: bigint, { signal }: Signal = {}): Promise<Quote> =>
    request({
      path: `/markets/${enc(tokenId)}/quote`,
      query: { side, amount: toDecimalString(amount) },
      schema: quoteSchema,
      signal,
    }),

  createIntent: (intent: IntentRequest, { signal }: Signal = {}): Promise<Intent> =>
    request({
      method: 'POST',
      path: '/orders/intents',
      body: {
        ...intent,
        amount: toDecimalString(intent.amount),
        minOut: toDecimalString(intent.minOut),
        maxNetworkFee: toDecimalString(intent.maxNetworkFee),
      },
      schema: intentSchema,
      signal,
    }),

  registerOrder: (txid: string, { signal }: Signal = {}): Promise<Registration> =>
    request({ method: 'POST', path: '/orders/register', body: { txid }, schema: registrationSchema, signal }),

  /** `id` is the funding `txid:vout`, or the funding txid alone for AtPrice-built orders (DD 10.5). */
  order: (id: string, { signal }: Signal = {}): Promise<Order> =>
    request({ path: `/orders/${enc(id)}`, schema: orderSchema, signal }),

  /** Orders owned by an exact owner address (no fuzzy listing). */
  ordersByAddress: async (address: string, { signal }: Signal = {}): Promise<readonly Order[]> =>
    (await request({ path: '/orders', query: { address }, schema: orderListSchema, signal })).orders,

  ordersByOutpoints: async (
    outpoints: readonly Outpoint[],
    { signal }: Signal = {},
  ): Promise<readonly Order[]> =>
    (
      await request({
        path: '/orders',
        query: { outpoints: outpoints.map(({ txid, vout }) => `${txid}:${vout}`).join(',') },
        schema: orderListSchema,
        signal,
      })
    ).orders,

  prepareCancel: (id: string, { signal }: Signal = {}): Promise<CancelPrepare> =>
    request({
      method: 'POST',
      path: `/orders/${enc(id)}/cancel/prepare`,
      body: {},
      schema: cancelPrepareSchema,
      signal,
    }),

  execution: (id: string, { signal }: Signal = {}): Promise<Execution> =>
    request({ path: `/executions/${enc(id)}`, schema: executionSchema, signal }),

  orderExecutions: (id: string, { signal }: Signal = {}): Promise<OrderExecutions> =>
    request({ path: `/orders/${enc(id)}/executions`, schema: orderExecutionsSchema, signal }),

  evidence: (
    { limit, cursor }: { readonly limit?: number; readonly cursor?: string | null } = {},
    { signal }: Signal = {},
  ): Promise<Evidence> =>
    request({
      path: '/evidence',
      query: { limit: limit?.toString(), cursor: cursor ?? undefined },
      schema: evidenceSchema,
      signal,
    }),
} as const;

export type ApiClient = typeof api;
