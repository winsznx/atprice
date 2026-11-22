import type { ElectrumEndpoint } from './networks.js';

export type ChainErrorReason =
  | 'no_endpoint_reachable'
  | 'genesis_mismatch'
  | 'not_connected'
  | 'request_failed'
  | 'request_timeout'
  | 'response_invalid'
  | 'broadcast_rejected'
  | 'closed';

/** Every failure in this package carries a stable `reason`; branch on it, never on the message. */
export class ChainError extends Error {
  constructor(
    readonly reason: ChainErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChainError';
  }
}

export interface EndpointFailure {
  readonly endpoint: ElectrumEndpoint;
  readonly reason: ChainErrorReason;
  readonly message: string;
}

export class NoEndpointReachableError extends ChainError {
  constructor(readonly failures: readonly EndpointFailure[]) {
    super(
      'no_endpoint_reachable',
      `no Electrum server reachable: ${failures
        .map(
          (failure) =>
            `${failure.endpoint.host}:${failure.endpoint.port} ${failure.reason} (${failure.message})`,
        )
        .join('; ')}`,
    );
    this.name = 'NoEndpointReachableError';
  }
}

export class BroadcastRejectedError extends ChainError {
  constructor(
    readonly via: 'electrum' | 'cauldron',
    readonly detail: string,
  ) {
    super('broadcast_rejected', `${via} rejected the transaction: ${detail}`);
    this.name = 'BroadcastRejectedError';
  }
}

/** Node rejection messages that mean an input is already spent (or double-spent in the mempool). */
const SPENT_INPUT_PATTERNS = [
  /missing.?inputs/i,
  /missingorspent/i,
  /txn-mempool-conflict/i,
  /bad-txns-inputs-missingorspent/i,
];

export const isSpentInputRejection = (detail: string): boolean =>
  SPENT_INPUT_PATTERNS.some((pattern) => pattern.test(detail));

/** Node rejection messages for a transaction the node already holds; the broadcast is effectively accepted. */
const ALREADY_KNOWN_PATTERNS = [
  /txn-already-known/i,
  /txn-already-in-mempool/i,
  /transaction already in block chain/i,
];

export const isAlreadyKnownRejection = (detail: string): boolean =>
  ALREADY_KNOWN_PATTERNS.some((pattern) => pattern.test(detail));
