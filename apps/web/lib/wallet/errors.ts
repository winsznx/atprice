/** Named failures of the wallet session and of a sign request (DD 7.8, notifications.md #11a, #11d). */
export type WalletErrorCode =
  /** The library failed to load or failed the boot-time compatibility check. */
  | 'WIZARDCONNECT_UNAVAILABLE'
  /** The library threw while pairing or resuming (for example a stored session with a bad key). */
  | 'WIZARDCONNECT_ERROR'
  /** No usable session: not connected, wrong network, or the receive path is missing. */
  | 'WALLET_NOT_READY'
  /** The wallet answered the sign request with a decline. */
  | 'WALLET_DECLINED'
  /** The session ended (disconnect, destroy) while the request was open. */
  | 'WALLET_SESSION_ENDED'
  /** The user pressed `Cancel request`. */
  | 'SIGN_REQUEST_CANCELLED'
  /** The signed transaction differs from the one built, or fails verification (`finalizeWalletSignedTransaction`). */
  | 'SIGNED_TX_MISMATCH';

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WalletError';
  }
}

export const isWalletError = (error: unknown): error is WalletError => error instanceof WalletError;
