import { ChainError, type ChainErrorReason } from '@atprice/chain';
import type {
  ChainClient,
  ChainHeader,
  ChainToken,
  ChainUtxo,
  HistoryEntry,
  TransactionStatus,
  Unsubscribe,
} from '@atprice/chain';

export { ChainError };
export type {
  ChainErrorReason,
  ChainHeader,
  ChainToken,
  ChainUtxo,
  HistoryEntry,
  TransactionStatus,
  Unsubscribe,
};

/**
 * The chain access the web app uses: `packages/chain`'s `ChainClient` methods plus a label for the
 * server answering now (`Couldn't read balances from {host}`). Typed as an interface so tests can pass
 * a fake chain.
 */
export interface ChainAccess extends Pick<
  ChainClient,
  | 'getRawTransaction'
  | 'getTransactionStatus'
  | 'getUtxos'
  | 'getHistory'
  | 'getTip'
  | 'broadcast'
  | 'subscribeAddress'
> {
  readonly endpointLabel: string | undefined;
}

export const isChainError = (error: unknown): error is ChainError => error instanceof ChainError;

/** The DD 7.13 name a screen prints for a chain failure. */
export const chainErrorCode = (error: ChainError): string => {
  switch (error.reason) {
    case 'no_endpoint_reachable':
    case 'not_connected':
    case 'request_timeout':
    case 'closed':
      return 'ELECTRUM_UNREACHABLE';
    case 'genesis_mismatch':
      return 'ELECTRUM_WRONG_NETWORK';
    case 'broadcast_rejected':
      return 'BROADCAST_REJECTED';
    case 'response_invalid':
      return 'ELECTRUM_RESPONSE_INVALID';
    case 'request_failed':
      return 'ELECTRUM_REQUEST_FAILED';
  }
};
