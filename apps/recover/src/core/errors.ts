import { ChainError } from '@atprice/chain';
import { chainErrorCode } from '../../../web/lib/chain/types';

/** Every Recover failure has one of these names, shown in mono next to the plain-words message. */
export type RecoverErrorCode =
  | 'ELECTRUM_UNREACHABLE'
  | 'ELECTRUM_WRONG_NETWORK'
  | 'ELECTRUM_REQUEST_FAILED'
  | 'ELECTRUM_RESPONSE_INVALID'
  | 'BROADCAST_REJECTED'
  | 'RECOVER_RECORD_INVALID'
  | 'RECOVER_DERIVATION_MISMATCH'
  | 'RECOVER_SPEND_NOT_FOUND'
  | 'CANCEL_BUILD_INVALID';

export class RecoverError extends Error {
  constructor(
    readonly code: RecoverErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RecoverError';
  }
}

export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The DD 7.13 name of any failure that reached the UI or the terminal. */
export const errorCode = (error: unknown): string => {
  if (error instanceof RecoverError) return error.code;
  if (error instanceof ChainError) return chainErrorCode(error);
  return 'RECOVER_UNEXPECTED';
};
