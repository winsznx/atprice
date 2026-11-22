import type { Network } from '@atprice/core';
import { z } from 'zod';
import { ChainError } from './errors.js';
import { CHAIN_NETWORKS } from './networks.js';

/** One active pool row from the indexer. A nomination only: the keeper re-reads the UTXO from Electrum. */
export interface IndexerPool {
  readonly poolId: string;
  readonly ownerPkh: string;
  readonly tokenId: string;
  readonly txid: string;
  readonly vout: number;
  readonly sats: bigint;
  readonly tokens: bigint;
}

export interface CauldronIndexerOptions {
  readonly network: Network;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DIGITS = z.string().regex(/^\d+$/);
const HASH = z.string().regex(/^[0-9a-f]{64}$/);

const rowSchema = z.object({
  owner_pkh: z.string().regex(/^[0-9a-f]{40}$/),
  pool_id: HASH,
  sats: DIGITS,
  token_id: HASH,
  tokens: DIGITS,
  tx_pos: DIGITS,
  txid: HASH,
});

const responseSchema = z.object({ active: z.array(rowSchema) });

/**
 * Parses JSON keeping every integer as its exact decimal text. The indexer sends token amounts as
 * JSON numbers, which `JSON.parse` would round above 2^53.
 */
export const parseJsonWithExactIntegers = (text: string): unknown => {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      let end = i + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end] ?? '')) end += 1;
      const literal = text.slice(i, end);
      out += /^-?\d+$/.test(literal) ? `"${literal}"` : literal;
      i = end - 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out);
};

/** REST client for the Cauldron indexer (`/cauldron/pool/active`), documented at docs.riftenlabs.com. */
export class CauldronIndexerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CauldronIndexerOptions) {
    this.baseUrl = (options.baseUrl ?? CHAIN_NETWORKS[options.network].cauldronIndexerUrl).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async activePools(tokenId: string): Promise<IndexerPool[]> {
    if (!/^[0-9a-f]{64}$/.test(tokenId))
      throw new ChainError('request_failed', `invalid token id ${tokenId}`);
    const url = `${this.baseUrl}/cauldron/pool/active?token=${tokenId}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new ChainError(
        timedOut ? 'request_timeout' : 'request_failed',
        `indexer ${url}: ${String(error)}`,
        {
          cause: error,
        },
      );
    }
    if (!response.ok) throw new ChainError('request_failed', `indexer ${url} answered ${response.status}`);
    const parsed = responseSchema.safeParse(parseJsonWithExactIntegers(await response.text()));
    if (!parsed.success)
      throw new ChainError('response_invalid', `indexer pool/active: ${parsed.error.message}`);
    return parsed.data.active
      .filter((row) => row.token_id === tokenId)
      .map((row) => ({
        poolId: row.pool_id,
        ownerPkh: row.owner_pkh,
        tokenId: row.token_id,
        txid: row.txid,
        vout: Number(row.tx_pos),
        sats: BigInt(row.sats),
        tokens: BigInt(row.tokens),
      }));
  }
}
