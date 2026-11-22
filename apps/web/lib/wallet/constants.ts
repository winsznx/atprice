/**
 * How long a pairing code stays on screen without a scan. A scannable code holds a relay subscription
 * open, so it can't wait forever; the user can extend it any number of times (DD 7.8, WCAG 2.2.1).
 */
export const PAIRING_TIMEOUT_MS = 5 * 60_000;

/** The `Keep waiting` notice appears this long before `PAIRING_TIMEOUT_MS` (DD 7.8 "pairing about to stop"). */
export const PAIRING_WARNING_MS = 30_000;

/**
 * A restored session that hasn't sent `wallet_ready` after this long is labelled `Wallet not answering`.
 * It ends nothing: the library keeps trying, and a late `wallet_ready` still connects (DD 7.8).
 */
export const RESTORE_TIMEOUT_MS = 20_000;

/** Consecutive unused addresses after which a path scan stops (wallet.md "Balances"). */
export const GAP_LIMIT = 20;

/** `Open in wallet app` reports no handler after the page stayed visible this long (wallet.md "Controls"). */
export const DEEP_LINK_FALLBACK_MS = 2_000;

/** Wallet balances refresh this often while connected (trade.md "Data sources"). */
export const BALANCE_REFRESH_MS = 30_000;

/** The `localStorage` key the dapp library persists its session under (research/wizardconnect.md section 4). */
export const SESSION_KEY = 'wizardconnect-session';

export const DAPP_NAME = 'AtPrice';

/**
 * How long a broadcast may stay unanswered before a flow says it couldn't confirm it and offers
 * `Check again`. It ends nothing: a late answer still moves the flow on (funding-confirmation.md).
 */
export const BROADCAST_TIMEOUT_MS = 20_000;
