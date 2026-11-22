import type { ChainHeader, ChainUtxo, ElectrumEndpoint } from '@atprice/chain';
import type { Logger } from 'pino';

export interface EvaluatorConnectionChain {
  readonly endpoint: { readonly host: string } | undefined;
  connect(): Promise<void>;
  close(): Promise<void>;
  getTip(): Promise<ChainHeader>;
  getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]>;
}

/**
 * The evaluator's own Electrum connection, kept off the server the keeper reports reading from. Each
 * process fails over on its own, so both can land on one host; when that happens this connection is
 * rebuilt with the keeper's host moved to the end of its list. If no other host answers it ends up back
 * on the keeper's server, and the health judge then reports `tip_lag` instead of trusting the comparison.
 */
export class IndependentConnection {
  private chain: EvaluatorConnectionChain;

  constructor(
    private readonly endpoints: readonly ElectrumEndpoint[],
    private readonly create: (endpoints: readonly ElectrumEndpoint[]) => EvaluatorConnectionChain,
    private readonly logger: Logger,
  ) {
    // Start from the second server: the keeper starts from the first.
    this.chain = create([...endpoints.slice(1), ...endpoints.slice(0, 1)]);
  }

  get current(): EvaluatorConnectionChain {
    return this.chain;
  }

  get host(): string | undefined {
    return this.chain.endpoint?.host;
  }

  async connect(): Promise<void> {
    await this.chain.connect();
  }

  async close(): Promise<void> {
    await this.chain.close();
  }

  /** Moves off `keeperHost` when this connection shares it. Returns true when it reconnected. */
  async ensureAwayFrom(keeperHost: string | undefined): Promise<boolean> {
    if (keeperHost === undefined || this.host?.toLowerCase() !== keeperHost.toLowerCase()) return false;
    const shared = (endpoint: ElectrumEndpoint): boolean =>
      endpoint.host.toLowerCase() === keeperHost.toLowerCase();
    const others = this.endpoints.filter((endpoint) => !shared(endpoint));
    if (others.length === 0) return false;
    this.logger.warn({ keeperHost }, 'evaluator shares the keeper Electrum server; reconnecting elsewhere');
    await this.chain.close();
    this.chain = this.create([...others, ...this.endpoints.filter(shared)]);
    await this.chain.connect();
    return true;
  }
}
