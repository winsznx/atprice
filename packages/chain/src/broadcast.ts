import type { Network } from '@atprice/core';
import { z } from 'zod';
import { BroadcastRejectedError, ChainError } from './errors.js';
import { CHAIN_NETWORKS } from './networks.js';

export interface CauldronBroadcastOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const responseSchema = z.union([
  z.object({ txid: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) }),
]);

/**
 * Riften's broadcast endpoint (`POST {tx}`), which Riften asks apps that spend Cauldron pools to use so
 * trades don't fragment the mempool.
 */
export class CauldronBroadcastClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CauldronBroadcastOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Returns the client for a network, or null where Riften documents no endpoint (chipnet). */
  static forNetwork(network: Network, fetchImpl?: typeof fetch): CauldronBroadcastClient | null {
    const url = CHAIN_NETWORKS[network].cauldronBroadcastUrl;
    if (url === null) return null;
    return new CauldronBroadcastClient({ url, ...(fetchImpl && { fetch: fetchImpl }) });
  }

  async broadcast(hex: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx: hex }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ChainError('request_failed', `cauldron broadcast: ${String(error)}`, { cause: error });
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ChainError(
        'response_invalid',
        `cauldron broadcast answered ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success)
      throw new ChainError('response_invalid', `cauldron broadcast: ${parsed.error.message}`);
    if ('error' in parsed.data) {
      const { code, message } = parsed.data.error;
      throw new BroadcastRejectedError('cauldron', message === undefined ? code : `${code}: ${message}`);
    }
    return parsed.data.txid;
  }
}
