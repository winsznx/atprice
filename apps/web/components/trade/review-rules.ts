import { formatBch, formatElapsed, formatToken } from '@/lib/format';

/*
 * DD 7.2 "Primary button disabled reasons", checked in this order and shown one at a time. Kept pure so
 * the order, which the spec pins, is tested without rendering the ticket.
 */

export type ReviewField = 'amount' | 'limit' | 'recipient';

export type WalletCondition =
  | { readonly kind: 'none' }
  | { readonly kind: 'resuming' }
  | { readonly kind: 'reconnecting'; readonly elapsedMs: number | null }
  | { readonly kind: 'wrong_network'; readonly walletNetwork: string; readonly appNetwork: string }
  | { readonly kind: 'missing_receive' }
  | { readonly kind: 'connected' };

export type MarketCondition =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'paused'; readonly reason: string }
  | { readonly kind: 'ok' };

export type BalanceCondition =
  | { readonly kind: 'not_needed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unknown'; readonly code: string }
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'bch_short';
      readonly side: 'buy' | 'sell';
      readonly balance: bigint;
      readonly needed: bigint;
    }
  | { readonly kind: 'tokens_short'; readonly balance: bigint; readonly amount: bigint };

export type FieldCondition =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ok' };

export interface ReviewInputs {
  readonly wallet: WalletCondition;
  readonly networkMismatch: { readonly web: string; readonly api: string } | null;
  readonly market: MarketCondition;
  /** Age of the quote in ms once it passed `expiresAt`, otherwise null. */
  readonly staleForMs: number | null;
  readonly balance: BalanceCondition;
  readonly amount: FieldCondition;
  readonly belowMinimum: { readonly minimum: bigint } | null;
  readonly limit: FieldCondition;
  readonly recipient: FieldCondition;
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly tokenDecimals: number;
}

export type ReviewGate =
  /** `Connect wallet`, enabled; `reason` is a market or network condition printed under it anyway. */
  | { readonly kind: 'connect'; readonly reason: string | null }
  | { readonly kind: 'blocked'; readonly reason: string; readonly field: ReviewField | null }
  | { readonly kind: 'ready' };

export const UNREACHABLE_REASON =
  'AtPrice’s server is not responding, so the quote and fee rate can’t be shown. Your existing orders stay on chain.';

const mismatchText = (mismatch: { web: string; api: string }): string =>
  `AtPrice is misconfigured: this page is on ${mismatch.web} but the server is on ${mismatch.api}. Orders are paused.`;

const ageText = (ms: number): string => formatElapsed(ms);

const marketReason = (inputs: ReviewInputs): string | null => {
  if (inputs.networkMismatch !== null) return mismatchText(inputs.networkMismatch);
  switch (inputs.market.kind) {
    case 'loading':
      return 'Loading market data.';
    case 'unreachable':
      return UNREACHABLE_REASON;
    case 'error':
      return `AtPrice’s server sent market data this page can’t use (${inputs.market.code}). Orders are paused until it does.`;
    case 'paused':
      return `Orders are paused for this market: ${inputs.market.reason}.`;
    case 'ok':
      break;
  }
  if (inputs.staleForMs !== null) {
    return `Pool data is out of date (last update ${ageText(inputs.staleForMs)} ago). Orders resume when fresh data arrives.`;
  }
  return null;
};

const fieldReason = (field: FieldCondition, emptyText: string): { readonly reason: string } | null => {
  if (field.kind === 'empty') return { reason: emptyText };
  if (field.kind === 'invalid') return { reason: field.message };
  return null;
};

export const reviewGate = (inputs: ReviewInputs): ReviewGate => {
  if (inputs.wallet.kind === 'none') return { kind: 'connect', reason: marketReason(inputs) };
  const blocked = (reason: string, field: ReviewField | null = null): ReviewGate => ({
    kind: 'blocked',
    reason,
    field,
  });
  if (inputs.networkMismatch !== null) return blocked(mismatchText(inputs.networkMismatch));
  switch (inputs.wallet.kind) {
    case 'resuming':
      return blocked('Resuming your wallet session. Requests resume when it answers.');
    case 'reconnecting':
      return blocked(
        `Reconnecting to your wallet (${inputs.wallet.elapsedMs === null ? '0:00' : formatElapsed(inputs.wallet.elapsedMs)}). Requests resume when it answers.`,
      );
    case 'wrong_network':
      return blocked(
        `Your wallet is on ${inputs.wallet.walletNetwork}. Switch it to ${inputs.wallet.appNetwork} to place orders.`,
      );
    case 'missing_receive':
      return blocked(
        'Your wallet didn’t share the receive key path AtPrice uses to own orders, so it can’t place orders here.',
      );
    case 'connected':
      break;
  }
  const market = marketReason(inputs);
  if (market !== null) return blocked(market);
  if (inputs.balance.kind === 'unknown') {
    return blocked(`Balance unknown, so the order can’t be built (${inputs.balance.code}).`);
  }
  const amount = fieldReason(inputs.amount, 'Enter an amount.');
  if (amount !== null) return blocked(amount.reason, 'amount');
  const unit = inputs.side === 'buy' ? 'BCH' : inputs.symbol;
  if (inputs.belowMinimum !== null) {
    const minimum =
      inputs.side === 'buy'
        ? formatBch(inputs.belowMinimum.minimum, 'compact')
        : formatToken(inputs.belowMinimum.minimum, inputs.tokenDecimals, 'compact');
    return blocked(`The minimum order is ${minimum} ${unit}, so fees stay a small share of it.`, 'amount');
  }
  switch (inputs.balance.kind) {
    case 'loading':
      return blocked('Reading your wallet’s coins.');
    case 'bch_short':
      return blocked(
        inputs.balance.side === 'buy'
          ? `You have ${formatBch(inputs.balance.balance, 'compact')} BCH. This order needs ${formatBch(inputs.balance.needed, 'compact')} BCH: the order, the network fee cap, token dust, the funding fee, and at least 1,000 sat kept at your owner address for a later cancel.`
          : `Sell orders also need ${formatBch(inputs.balance.needed, 'compact')} BCH: 2,000 sat locked with the tokens, the funding fee, and at least 1,000 sat kept at your owner address for a later cancel. Your wallet has ${formatBch(inputs.balance.balance, 'compact')} BCH.`,
        'amount',
      );
    case 'tokens_short':
      return blocked(
        `You have ${formatToken(inputs.balance.balance, inputs.tokenDecimals, 'compact')} ${inputs.symbol}. This order sells ${formatToken(inputs.balance.amount, inputs.tokenDecimals, 'compact')} ${inputs.symbol}.`,
        'amount',
      );
    case 'not_needed':
    case 'ok':
      break;
  }
  const limit = fieldReason(inputs.limit, 'Enter a limit price above zero.');
  if (limit !== null) return blocked(limit.reason, 'limit');
  if (inputs.recipient.kind !== 'ok') return blocked('Fix the recipient address.', 'recipient');
  return { kind: 'ready' };
};
