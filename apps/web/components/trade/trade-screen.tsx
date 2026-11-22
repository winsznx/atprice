'use client';

import { binToHex } from '@bitauth/libauth';
import { AtPriceError, type MarketDefinition, type OrderSide, type PriceRatio } from '@atprice/core';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldWarningIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { EmptyState } from '@/components/states';
import { api } from '@/lib/api/client';
import { isApiError, isUnreachable } from '@/lib/api/errors';
import { queries } from '@/lib/api/queries';
import { chainErrorCode, isChainError } from '@/lib/chain/types';
import { formatBch, formatPercent, formatToken, orientRate, type RateOrientation } from '@/lib/format';
import { useIsLgUp, useIsShort, useIsTall } from '@/lib/hooks/use-media-query';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';
import { useElapsed, useNow } from '@/lib/hooks/use-now';
import { appNetwork } from '@/lib/network';
import { getNotificationCenter } from '@/lib/notifications/store';
import { cn } from '@/lib/utils';
import { wrongNetworkCopy, type WalletState } from '@/lib/wallet/connector';
import { walletNetworkLabel } from '@/lib/wallet/keys';
import { getWalletConnector, ownerOf, useWalletScan, useWalletState } from '@/lib/wallet/store';
import { openConnectModal } from '@/lib/wallet/ui-store';
import { closingNotification, createBrowserFlow } from '../funding/browser-flow';
import { draftSnapshot, newDraftId, type StoredDraft } from '@/lib/orders/draft-store';
import { FundingDialog, type DialogWallet } from '../funding/funding-dialog';
import { FundingStatusCard } from '../funding/funding-status-card';
import {
  coreErrorCode,
  deriveOrder,
  intentAddressMatches,
  intentRequest,
  MAX_NETWORK_FEE,
  parseRecipient,
} from '../funding/order-terms';
import type { FundingSession } from '../funding/session';
import { useTicketFunding } from './use-ticket-funding';
import {
  useDebouncedValue,
  useKeyboardOpen,
  useOnScreen,
  useStickyBarHeight,
  useTicketFits,
  QUOTE_DEBOUNCE_MS,
} from './hooks';
import { MarketBar, type MarketListView } from './market-bar';
import { MarketHistory, MarketStats, type MarketDetailView, type RecentFillsView } from './market-panel';
import { marketByCategory, marketSlug, pairText } from './market';
import { OrderSummary, tokensPerBchText } from './order-summary';
import { OrderTicket, type BalanceLine, type Enablement, type RecipientProps } from './order-ticket';
import { QuotePanel, type QuoteView } from './quote-panel';
import {
  reviewGate,
  type BalanceCondition,
  type MarketCondition,
  type WalletCondition,
} from './review-rules';
import { RiskList } from './risk-list';
import {
  BCH_DECIMALS,
  limitDecimals,
  limitUnit,
  limitVersusRate,
  minimumTerms,
  offsetLimitText,
  parseAmount,
  parseLimit,
  ratioInputText,
  sanitizeDecimalInput,
  unitsInputText,
  type MinimumTerms,
  type OffsetBps,
} from './terms';
import { TradeAction, type CheckState, type MinimumLine } from './trade-action';

interface LimitInput {
  readonly text: string;
  readonly orientation: RateOrientation;
}

type RecipientInput = { readonly mode: 'wallet' } | { readonly mode: 'custom'; readonly text: string };

interface Snapshot {
  readonly side: OrderSide;
  readonly amountText: string;
  readonly limit: LimitInput;
}

const EVIDENCE_PAGE = 50;
const RECENT_FILLS = 8;

const walletCondition = (state: WalletState, elapsedMs: number | null): WalletCondition => {
  switch (state.kind) {
    case 'resuming':
      return { kind: 'resuming' };
    case 'connected':
    case 'wrong_network':
    case 'missing_receive':
      if (state.reconnectingSince !== null) return { kind: 'reconnecting', elapsedMs };
      if (state.kind === 'wrong_network') {
        return {
          kind: 'wrong_network',
          walletNetwork: walletNetworkLabel(state.walletNetwork),
          appNetwork: appNetwork.name,
        };
      }
      return state.kind === 'missing_receive' ? { kind: 'missing_receive' } : { kind: 'connected' };
    default:
      return { kind: 'none' };
  }
};

const reconnectingSince = (state: WalletState): number | null =>
  state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive'
    ? state.reconnectingSince
    : null;

/** Phases before anything was signed: a reconnect by the same owner rebuilds from fresh coins. */
const PRE_SIGN_PHASES: ReadonlySet<string> = new Set([
  'review',
  'building',
  'utxo_error',
  'rejected',
  'signing_error',
]);

const orderAmountText = (side: OrderSide, amount: bigint, market: MarketDefinition): string =>
  side === 'buy'
    ? `${formatBch(amount, 'compact')} BCH`
    : `${formatToken(amount, market.decimals, 'compact')} ${market.symbol}`;

/** Core's minimum for the typed terms, or the reason the limit can't make one. */
const orderTerms = (
  side: OrderSide,
  amount: bigint | null,
  price: PriceRatio | null,
): { readonly terms: MinimumTerms | null; readonly error: string | null } => {
  if (amount === null || price === null) return { terms: null, error: null };
  try {
    return { terms: minimumTerms(side, amount, price), error: null };
  } catch (error) {
    if (!(error instanceof AtPriceError)) throw error;
    return {
      terms: null,
      error:
        side === 'sell'
          ? 'At this limit the amount sells for less than 1 satoshi. Raise the limit or the amount.'
          : 'This limit price is outside what an order can hold.',
    };
  }
};

/** Read in event handlers only (the `Checking order` start time). */
const currentTime = (): number => Date.now();

const apiCode = (error: unknown): string => (isApiError(error) ? error.displayCode : 'API_ERROR');

export interface TradeScreenProps {
  readonly tokenCategory: string;
  readonly initialSide: OrderSide | null;
  /** `?draft={id}`: restore this tab's unfunded draft (trade.md "Restoring a draft"). */
  readonly draftId: string | null;
  /** `/trade/[slug]` uses `h1`; `/` puts its own home heading first and passes `h2` (landing.md). */
  readonly headingAs?: 'h1' | 'h2';
  /**
   * Below lg, `always` keeps the action bar on screen (trade.md); `while-visible` shows it only while
   * the trade area is in the viewport, so on `/` it never covers the sections below (landing.md).
   */
  readonly stickyBar?: 'always' | 'while-visible';
}

/** `pending` until hydration has read this tab's storage, then the draft or `missing`. */
type Restored = StoredDraft | 'none' | 'pending' | 'missing';

const noSubscription = (): (() => void) => () => undefined;

export function TradeScreen(props: TradeScreenProps) {
  const market = marketByCategory(props.tokenCategory);
  const { draftId } = props;
  const restored = useSyncExternalStore<Restored>(
    noSubscription,
    () => {
      if (draftId === null || market === undefined) return 'none';
      const draft = draftSnapshot();
      return draft !== null && draft.draftId === draftId && draft.slug === marketSlug(market)
        ? draft
        : 'missing';
    },
    () => (draftId === null ? 'none' : 'pending'),
  );

  // `?draft` is read once, then removed so a reload doesn't restore twice (trade.md "Route").
  useEffect(() => {
    if (draftId === null || restored === 'pending') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('draft');
    window.history.replaceState(window.history.state, '', url.toString());
  }, [draftId, restored]);

  if (market === undefined) return null;
  return (
    <TradeScreenFor
      key={typeof restored === 'string' ? restored : restored.draftId}
      market={market}
      restored={restored}
      {...props}
    />
  );
}

const initialTicket = (restored: Restored, market: MarketDefinition, initialSide: OrderSide | null) => {
  if (typeof restored === 'string') {
    return {
      side: initialSide ?? ('buy' as OrderSide),
      amountText: '',
      limit: { text: '', orientation: 'tokens_per_bch' as RateOrientation },
      recipient: { mode: 'wallet' } as RecipientInput,
      check:
        restored === 'missing'
          ? ({
              kind: 'notice',
              text: 'That draft is no longer in this tab, so the ticket starts empty.',
            } as CheckState)
          : ({ kind: 'idle' } as CheckState),
    };
  }
  return {
    side: restored.side,
    amountText: unitsInputText(
      BigInt(restored.amount),
      restored.side === 'buy' ? BCH_DECIMALS : market.decimals,
    ),
    limit: { text: restored.limitText, orientation: restored.limitOrientation },
    recipient: (restored.recipient === null
      ? { mode: 'wallet' }
      : { mode: 'custom', text: restored.recipient }) as RecipientInput,
    check: { kind: 'idle' } as CheckState,
  };
};

function TradeScreenFor({
  market,
  initialSide,
  restored,
  headingAs = 'h1',
  stickyBar = 'always',
}: TradeScreenProps & { readonly market: MarketDefinition; readonly restored: Restored }) {
  const [initial] = useState(() => initialTicket(restored, market, initialSide));
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokenCategory = market.tokenCategory;

  const detailQuery = useQuery({ ...queries.market(tokenCategory), refetchInterval: 15_000 });
  const listQuery = useQuery({ ...queries.markets(), refetchInterval: 60_000 });
  const networkQuery = useQuery({ ...queries.network(), refetchInterval: 60_000 });
  const evidenceQuery = useQuery({ ...queries.evidence(null, EVIDENCE_PAGE), refetchInterval: 30_000 });
  const networkCheck = useNetworkCheck();
  const wallet = useWalletState();
  const owner = ownerOf(wallet);
  const scanQuery = useWalletScan(owner);
  const now = useNow();
  const reconnectElapsed = useElapsed(reconnectingSince(wallet));

  const [side, setSide] = useState<OrderSide>(initial.side);
  const [amountText, setAmountText] = useState(initial.amountText);
  const [limit, setLimit] = useState<LimitInput>(initial.limit);
  const [display, setDisplay] = useState<RateOrientation>(initial.limit.orientation);
  const [recipient, setRecipient] = useState<RecipientInput>(initial.recipient);
  const [undo, setUndo] = useState<Snapshot | null>(null);
  const [check, setCheck] = useState<CheckState>(initial.check);
  const [session, setSession] = useState<FundingSession | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const restorePending = useRef(typeof restored === 'string' ? null : restored);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const mismatchRef = useRef<HTMLHeadingElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const limitRef = useRef<HTMLInputElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const ticketRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const dialogOpenRef = useRef(false);

  // Amount and limit, exact (DD 7.2).
  const amountDecimals = side === 'buy' ? BCH_DECIMALS : market.decimals;
  const amountUnit = side === 'buy' ? 'BCH' : market.symbol;
  const amountParse = parseAmount(amountText, amountDecimals, amountUnit);
  const amountUnits = amountParse.kind === 'ok' ? amountParse.units : null;
  const minimumAmount = market.minimumAmount[side];
  const limitParse = parseLimit(limit.text, limit.orientation, market.decimals, market.symbol);
  const price = limitParse.kind === 'ok' ? limitParse.price : null;
  const { terms, error: termsError } = orderTerms(side, amountUnits, price);

  const termsMinOut = terms?.minOut ?? null;

  // Quote for the typed amount: 250 ms after typing stops, then every 10 s while visible.
  const quoteKey = useDebouncedValue(
    amountUnits === null ? null : `${side}:${amountUnits.toString()}`,
    QUOTE_DEBOUNCE_MS,
  );
  const quotedUnits = quoteKey === null ? null : BigInt(quoteKey.slice(quoteKey.indexOf(':') + 1));
  const quotedSide: OrderSide = quoteKey?.startsWith('sell') ? 'sell' : 'buy';
  const quoteQuery = useQuery({
    ...queries.quote(tokenCategory, quotedSide, quotedUnits ?? 1n),
    enabled: quotedUnits !== null,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const detail = detailQuery.data;
  const network = networkQuery.data;

  const amountDisplay =
    amountUnits === null
      ? ''
      : side === 'buy'
        ? `${formatBch(amountUnits, 'compact')} BCH`
        : `${formatToken(amountUnits, market.decimals, 'compact')} ${market.symbol}`;

  let quoteView: QuoteView;
  const quote = quoteQuery.data;
  if (amountUnits === null) {
    quoteView = { kind: 'no_amount' };
  } else if (quote === undefined) {
    if (quoteQuery.isError) {
      const error = quoteQuery.error;
      quoteView =
        isApiError(error) && error.status === 409
          ? { kind: 'unavailable', amountText: amountDisplay, code: error.displayCode }
          : {
              kind: 'error',
              code: apiCode(error),
              message: error instanceof Error ? error.message : String(error),
              retry: () => void quoteQuery.refetch(),
            };
    } else {
      quoteView = { kind: 'loading' };
    }
  } else if (
    quoteQuery.isError &&
    isApiError(quoteQuery.error) &&
    quoteQuery.error.status === 409 &&
    !quoteQuery.isPlaceholderData
  ) {
    quoteView = { kind: 'unavailable', amountText: amountDisplay, code: quoteQuery.error.displayCode };
  } else {
    const current = quote.side === side && quote.amountIn === amountUnits;
    quoteView = {
      kind: 'ready',
      quote,
      updating: !current || quoteQuery.isPlaceholderData,
      stale: now !== null && now > Date.parse(quote.expiresAt),
    };
  }
  const freshQuote = quoteView.kind === 'ready' && !quoteView.updating ? quoteView.quote : null;
  const staleForMs =
    quoteView.kind === 'ready' && quoteView.stale && now !== null
      ? now - Date.parse(quoteView.quote.calculatedAt)
      : null;

  // Market condition for the gate (DD 7.2 order).
  let marketCondition: MarketCondition;
  if (detail === undefined) {
    marketCondition = detailQuery.isError
      ? isUnreachable(detailQuery.error)
        ? { kind: 'unreachable' }
        : { kind: 'error', code: apiCode(detailQuery.error) }
      : { kind: 'loading' };
  } else if (network === undefined && networkQuery.isError) {
    marketCondition = isUnreachable(networkQuery.error)
      ? { kind: 'unreachable' }
      : { kind: 'error', code: apiCode(networkQuery.error) };
  } else if (network === undefined) {
    marketCondition = { kind: 'loading' };
  } else if (detail.availability === 'paused') {
    marketCondition = { kind: 'paused', reason: detail.availabilityReason ?? 'no reason was given' };
  } else {
    marketCondition = { kind: 'ok' };
  }
  const marketLoading = detail === undefined && !detailQuery.isError;

  // Recipient.
  const recipientParse = useMemo(
    () => (recipient.mode === 'custom' ? parseRecipient(recipient.text, side, appNetwork) : null),
    [recipient, side],
  );
  const recipientBytes = recipientParse?.kind === 'ok' ? recipientParse.lockingBytecode : null;

  // Wallet coins and core's funding preview (balance checks quote the builder's own numbers).
  const scan = scanQuery.data;
  const tokenBalance = scan?.tokens.find((token) => token.category === tokenCategory)?.fungible ?? 0n;
  const { preview, fees, maxValue } = useTicketFunding({
    owner,
    recipientBytes,
    side,
    tokenCategory,
    minOut: termsMinOut,
    scan,
    network,
    amount: amountUnits,
    minimumAmount,
    tokenBalance,
  });

  let balance: BalanceCondition;
  if (owner === null) balance = { kind: 'not_needed' };
  else if (scanQuery.isError && scan === undefined)
    balance = {
      kind: 'unknown',
      code: isChainError(scanQuery.error) ? chainErrorCode(scanQuery.error) : 'WALLET_SCAN_FAILED',
    };
  else if (scan === undefined) balance = { kind: 'loading' };
  else if (preview?.kind === 'short' && preview.resource === 'bch')
    balance = { kind: 'bch_short', side, balance: scan.bchSats, needed: preview.required };
  else if (preview?.kind === 'short')
    balance = { kind: 'tokens_short', balance: tokenBalance, amount: amountUnits ?? 0n };
  else balance = { kind: 'ok' };

  const amountError = amountParse.kind === 'invalid' ? amountParse.message : null;
  const limitError = limitParse.kind === 'invalid' ? limitParse.message : termsError;

  const gate = reviewGate({
    wallet: walletCondition(wallet, reconnectElapsed),
    networkMismatch:
      networkCheck.status === 'mismatch' ? { web: networkCheck.web, api: networkCheck.api } : null,
    market: marketCondition,
    staleForMs,
    balance,
    amount:
      amountError !== null
        ? { kind: 'invalid', message: amountError }
        : amountUnits === null
          ? { kind: 'empty' }
          : { kind: 'ok' },
    belowMinimum: amountUnits !== null && amountUnits < minimumAmount ? { minimum: minimumAmount } : null,
    limit:
      limitError !== null
        ? { kind: 'invalid', message: limitError }
        : price === null
          ? { kind: 'empty' }
          : { kind: 'ok' },
    recipient:
      recipientParse === null || recipientParse.kind === 'ok'
        ? { kind: 'ok' }
        : { kind: 'invalid', message: recipientParse.message },
    side,
    symbol: market.symbol,
    tokenDecimals: market.decimals,
  });

  let max: Enablement;
  if (owner === null) max = { enabled: false, reason: 'Connect a wallet to use Max.' };
  else if (scan === undefined) max = { enabled: false, reason: 'Balance unknown.' };
  else if (maxValue === null || maxValue < minimumAmount)
    max = { enabled: false, reason: 'Your balance does not cover the minimum order plus fees.' };
  else max = { enabled: true };

  let balanceLine: BalanceLine;
  if (wallet.kind === 'wrong_network') balanceLine = { kind: 'hidden' };
  else if (owner === null) balanceLine = { kind: 'disconnected' };
  else if (balance.kind === 'unknown')
    balanceLine = { kind: 'unknown', code: balance.code, retry: () => void scanQuery.refetch() };
  else if (scan === undefined) balanceLine = { kind: 'loading' };
  else
    balanceLine = {
      kind: 'known',
      text:
        side === 'buy'
          ? `${formatBch(scan.bchSats, 'compact')} BCH`
          : `${formatToken(tokenBalance, market.decimals, 'compact')} ${market.symbol}`,
    };

  // Limit display, offsets and the offset line.
  const spot = detail?.spotRate.value ?? null;
  const reference =
    freshQuote !== null
      ? { label: 'Rate now' as const, price: freshQuote.effectiveRate }
      : amountUnits === null && spot !== null
        ? { label: 'Spot' as const, price: spot }
        : quote !== undefined && amountUnits !== null
          ? { label: 'Rate now' as const, price: quote.effectiveRate }
          : spot === null
            ? null
            : { label: 'Spot' as const, price: spot };
  const limitInputText =
    display === limit.orientation
      ? limit.text
      : price === null
        ? ''
        : ratioInputText(
            orientRate(price, market.decimals, display),
            limitDecimals(display, market.decimals),
          );
  const offsetLine =
    price !== null && reference !== null ? limitVersusRate(side, price, reference.price) : null;

  const minimum: MinimumLine = {
    value:
      terms === null
        ? null
        : side === 'buy'
          ? `${formatToken(terms.minProceeds, market.decimals, 'exact')} ${market.symbol}`
          : `${formatBch(terms.minProceeds, 'exact')} BCH`,
    explanation:
      amountUnits === null
        ? null
        : `Fills only when one Cauldron pool can pay at least this for your whole ${amountDisplay}, after its 0.3% fee.`,
    payout:
      side === 'sell' && terms !== null
        ? `Paid in one output of at least ${formatBch(terms.minProceeds + 2_000n, 'exact')} BCH: your proceeds plus the 2,000 sat reserve you locked. The network fee comes out of the pool’s BCH, not out of this.`
        : null,
  };

  const versusLine =
    freshQuote === null || terms === null || price === null
      ? null
      : freshQuote.amountOut >= terms.minProceeds
        ? 'Versus your limit: your limit is reachable now.'
        : (() => {
            const gap = limitVersusRate(side, price, freshQuote.effectiveRate);
            return `Versus your limit: needs a ${formatPercent(gap.numerator, gap.denominator)} better rate.`;
          })();

  // Focus follows the named message after it renders (INTENT_MISMATCH heading, notices).
  useEffect(() => {
    if (check.kind === 'mismatch') mismatchRef.current?.focus();
    if (check.kind === 'notice') noticeRef.current?.focus();
  }, [check]);

  const closeDialog = (current: FundingSession) => {
    const phase = current.flow.getPhase();
    const notification = closingNotification(phase, {
      draftId: current.draftId,
      amountText: orderAmountText(current.order.params.side, current.order.amount, current.market),
      checkAgain: () => void current.flow.checkAgain(),
    });
    dialogOpenRef.current = false;
    setDialogOpen(false);
    current.flow.dispose();
    if (notification !== null) getNotificationCenter().raiseOnClose(notification);
  };

  // The dialog registers as the funding flow's modal, so its own messages stay in it (notifications.md).
  useEffect(() => {
    if (!dialogOpen || session === null) return;
    return getNotificationCenter().openModal('funding', session.draftId);
  }, [dialogOpen, session]);

  // A wallet that reconnects while the dialog is open: same owner rebuilds, another owner closes it.
  useEffect(() => {
    if (!dialogOpen || session === null) return;
    const connector = getWalletConnector();
    let previous = connector.getState();
    return connector.subscribe(() => {
      const next = connector.getState();
      const before = previous;
      previous = next;
      if (next.kind === 'wrong_network' && before.kind !== 'wrong_network') {
        closeDialog(session);
        setCheck({ kind: 'notice', text: wrongNetworkCopy(next.walletNetwork, appNetwork) });
        return;
      }
      if (next.kind !== 'connected' || before.kind === 'connected') return;
      if (next.owner.ownerPkhHex !== session.ownerPkhHex) {
        closeDialog(session);
        setCheck({ kind: 'notice', text: 'This order was set up for a different wallet. Review it again.' });
        return;
      }
      if (PRE_SIGN_PHASES.has(session.flow.getPhase().kind)) void session.flow.build();
    });
  }, [dialogOpen, session]);

  const openFunding = (
    order: ReturnType<typeof deriveOrder>,
    verification: FundingSession['verification'],
  ) => {
    if (owner === null || terms === null || network === undefined) return;
    const id = newDraftId();
    const recipientAddress =
      recipient.mode === 'custom'
        ? recipient.text.trim()
        : side === 'buy'
          ? owner.tokenAddress
          : owner.address;
    const draft: StoredDraft = {
      draftId: id,
      slug: marketSlug(market),
      side,
      amount: order.amount.toString(),
      limitText: limit.text,
      limitOrientation: limit.orientation,
      recipient: recipient.mode === 'custom' ? recipient.text.trim() : null,
      ownerPkh: owner.ownerPkhHex,
      contractAddress: order.orderAddress,
    };
    const current: { session: FundingSession | null } = { session: null };
    const flow = createBrowserFlow({
      draftId: id,
      order,
      minimumAmount,
      feePerByte: network.feeRateSatsPerByte,
      ownerPkhHex: owner.ownerPkhHex,
      amountText:
        side === 'buy'
          ? `${formatBch(order.amount, 'compact')} BCH`
          : `${formatToken(order.amount, market.decimals, 'compact')} ${market.symbol}`,
      draft,
      queryClient,
      onRegistered: (txid) => {
        if (!dialogOpenRef.current || current.session === null) return;
        closeDialog(current.session);
        router.push(`/orders/${txid}`);
      },
    });
    const next: FundingSession = {
      draftId: id,
      flow,
      order,
      market,
      minProceeds: terms.minProceeds,
      limit,
      recipientAddress,
      recipientIsWallet: recipient.mode === 'wallet',
      ownerAddress: owner.address,
      ownerPkhHex: owner.ownerPkhHex,
      verification,
      feePerByte: network.feeRateSatsPerByte,
      protocolFeeBps: network.protocolFeeBps,
    };
    current.session = next;
    setSession(next);
    dialogOpenRef.current = true;
    setDialogOpen(true);
    setCheck({ kind: 'idle' });
    void flow.build();
  };

  /** DD 7.2 steps a to d. Nothing is sent to the wallet unless the server derived the same address. */
  const startReview = async () => {
    if (owner === null || terms === null || amountUnits === null) return;
    setCheck({ kind: 'checking', since: currentTime() });
    let order: ReturnType<typeof deriveOrder>;
    try {
      order = deriveOrder(
        {
          side,
          tokenCategory,
          amount: amountUnits,
          minOut: terms.minOut,
          ownerPkh: owner.ownerPkh,
          recipientLockingBytecode: recipientBytes,
        },
        appNetwork.network,
      );
    } catch (error) {
      if (!(error instanceof AtPriceError)) throw error;
      setCheck({ kind: 'rejected', code: coreErrorCode(error), message: error.message });
      return;
    }
    try {
      const intent = await api.createIntent(intentRequest(order));
      if (intentAddressMatches(intent.orderAddress, order)) {
        openFunding(order, 'matched');
      } else {
        console.error('INTENT_MISMATCH: the server derived a different contract address.', {
          server: intent.orderAddress,
          browser: order.orderAddress,
          ownerPkh: binToHex(order.params.ownerPkh),
        });
        setCheck({ kind: 'mismatch' });
      }
    } catch (error) {
      if (!isApiError(error)) {
        console.error('The order check failed:', error);
        setCheck({ kind: 'unanswered', code: 'INTENT_CHECK_FAILED' });
        return;
      }
      if (error.status === 429) {
        openFunding(order, 'limit_reached');
      } else if (error.serverCode === 'address_mismatch' || error.serverCode === 'INTENT_MISMATCH') {
        console.error('INTENT_MISMATCH: the server refused the browser-derived address.', {
          browser: order.orderAddress,
          message: error.message,
        });
        setCheck({ kind: 'mismatch' });
      } else if (
        isUnreachable(error) ||
        error.code === 'API_RESPONSE_INVALID' ||
        (error.status !== null && error.status >= 500)
      ) {
        setCheck({ kind: 'unanswered', code: error.displayCode });
      } else {
        setCheck({ kind: 'rejected', code: error.displayCode, message: error.message });
      }
    }
  };

  // Restore continues once the wallet, market and coins are known (trade.md "Restoring a draft"). The
  // wallet session resumes over the relay and the coins arrive from Electrum, so this follows those
  // external systems; it runs once and then clears its pointer.
  /* eslint-disable react-hooks/set-state-in-effect -- the restore answers a wallet session and coins that just arrived */
  useEffect(() => {
    const draft = restorePending.current;
    if (draft === null || wallet.kind !== 'connected') return;
    if (wallet.owner.ownerPkhHex !== draft.ownerPkh) {
      restorePending.current = null;
      setCheck({
        kind: 'notice',
        text: 'This draft was set up for a different wallet. The ticket is filled in; review it again to create a new order for this wallet.',
      });
      return;
    }
    if (marketCondition.kind === 'loading' || balance.kind === 'loading' || quoteView.kind === 'loading')
      return;
    restorePending.current = null;
    if (gate.kind === 'ready') {
      void startReview();
    } else if (gate.kind === 'blocked') {
      setCheck({ kind: 'notice', text: `The draft wasn’t reopened. ${gate.reason}` });
    }
    // Runs when its inputs settle; startReview reads this render's values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, marketCondition.kind, balance.kind, quoteView.kind, gate.kind]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const onSideChange = (next: OrderSide) => {
    if (next === side) return;
    setUndo(amountText !== '' || limit.text !== '' ? { side, amountText, limit } : null);
    setSide(next);
    setAmountText('');
    setLimit({ text: '', orientation: display });
    setCheck({ kind: 'idle' });
  };

  const onPrimary = () => {
    if (check.kind === 'checking') return;
    if (gate.kind === 'connect') {
      openConnectModal({ trigger: buttonRef.current, fallback: () => buttonRef.current });
      return;
    }
    if (gate.kind === 'blocked') {
      const target =
        gate.field === 'amount'
          ? amountRef
          : gate.field === 'limit'
            ? limitRef
            : gate.field === 'recipient'
              ? recipientRef
              : null;
      target?.current?.focus();
      return;
    }
    void startReview();
  };

  const recipientProps: RecipientProps =
    recipient.mode === 'custom'
      ? {
          mode: 'custom',
          text: recipient.text,
          error: recipientParse?.kind === 'invalid' ? recipientParse.message : null,
          onText: (text) => setRecipient({ mode: 'custom', text }),
          onUseWallet: () => setRecipient({ mode: 'wallet' }),
        }
      : owner === null || wallet.kind !== 'connected'
        ? { mode: 'disconnected' }
        : {
            mode: 'wallet',
            address: side === 'buy' ? owner.tokenAddress : owner.address,
            onChange: () => {
              setRecipient({ mode: 'custom', text: '' });
              requestAnimationFrame(() => recipientRef.current?.focus());
            },
          };

  const checkElapsed = useElapsed(check.kind === 'checking' ? check.since : null);
  const label =
    check.kind === 'checking'
      ? 'Checking order'
      : gate.kind === 'connect'
        ? 'Connect wallet'
        : 'Review order';
  const reason =
    gate.kind === 'connect'
      ? gate.reason === null
        ? null
        : { text: gate.reason, blocks: false }
      : gate.kind === 'blocked'
        ? { text: gate.reason, blocks: true }
        : null;

  const isLgUp = useIsLgUp();
  const isShort = useIsShort();
  const isTall = useIsTall();
  const keyboardOpen = useKeyboardOpen();
  const ticketFits = useTicketFits(ticketRef);
  const areaOnScreen = useOnScreen(areaRef, stickyBar === 'while-visible');
  const placement: 'ticket' | 'inline' | 'bar' = isLgUp
    ? 'ticket'
    : keyboardOpen || isShort || !areaOnScreen
      ? 'inline'
      : 'bar';
  useStickyBarHeight(barRef, placement === 'bar');

  const action = (
    <TradeAction
      placement={placement}
      minimum={minimum}
      label={label}
      reason={reason}
      busy={check.kind === 'checking'}
      checkElapsedMs={checkElapsed}
      check={check}
      onClick={onPrimary}
      onTryAgain={() => void startReview()}
      buttonRef={buttonRef}
      noticeRef={noticeRef}
      mismatchRef={mismatchRef}
    />
  );

  const detailView: MarketDetailView =
    detail !== undefined
      ? { kind: 'ready', detail }
      : detailQuery.isError
        ? {
            kind: 'error',
            code: apiCode(detailQuery.error),
            message: isUnreachable(detailQuery.error)
              ? 'AtPrice’s server is not responding, so the quote and fee rate can’t be shown. Your existing orders stay on chain.'
              : `Market data couldn’t be loaded: ${detailQuery.error.message}`,
            retry: () => void detailQuery.refetch(),
          }
        : { kind: 'loading' };

  const listView: MarketListView =
    listQuery.data !== undefined
      ? { kind: 'ready', markets: listQuery.data }
      : listQuery.isError
        ? { kind: 'error' }
        : { kind: 'loading' };

  const fillsView: RecentFillsView =
    evidenceQuery.data !== undefined
      ? {
          kind: 'ready',
          fills: evidenceQuery.data.orders
            .filter((order) => order.tokenCategory === tokenCategory && order.settlement.kind === 'fill')
            .slice(0, RECENT_FILLS),
        }
      : evidenceQuery.isError
        ? { kind: 'error', code: apiCode(evidenceQuery.error), retry: () => void evidenceQuery.refetch() }
        : { kind: 'loading' };

  const lowLiquidityNote =
    detail?.availability === 'low_liquidity'
      ? `This market has ${formatToken(detail.liquidity.tokens, market.decimals, 'compact')} ${market.symbol} and ${formatBch(detail.liquidity.sats, 'compact')} BCH in pools. Large orders may never fill.`
      : null;
  const apiDown = marketCondition.kind === 'unreachable';
  const unverified = detail !== undefined && !detail.verified;

  const dialogWallet: DialogWallet =
    wallet.kind === 'connected'
      ? wallet.reconnectingSince === null
        ? { kind: 'connected' }
        : { kind: 'reconnecting', since: wallet.reconnectingSince }
      : { kind: 'disconnected' };

  const Heading = headingAs;
  const summaryTerms =
    terms === null || amountUnits === null || price === null
      ? null
      : {
          amount: amountUnits,
          minOut: terms.minOut,
          minProceeds: terms.minProceeds,
          limitTokensPerBch: tokensPerBchText(limit, price, market.decimals),
        };

  return (
    <div
      ref={areaRef}
      className="mx-auto w-full max-w-(--container-app) px-(--space-gutter) py-6 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-8"
    >
      <Heading className="sr-only">{`Trade ${pairText(market)}`}</Heading>
      <div className="mb-6">
        <MarketBar market={market} list={listView} availability={detail?.availability ?? null} />
      </div>
      <div
        className={cn(
          'grid min-w-0 gap-6',
          "[grid-template-areas:'stats'_'ticket'_'summary'_'history']",
          "md:grid-cols-2 md:[grid-template-areas:'stats_stats'_'history_history'_'ticket_summary']",
          "lg:grid-cols-[300px_minmax(340px,440px)_minmax(260px,1fr)] lg:grid-rows-[auto_1fr] lg:[grid-template-areas:'stats_ticket_summary'_'history_ticket_summary']",
          'xl:grid-cols-[360px_440px_1fr]',
        )}
      >
        <div
          ref={ticketRef}
          className={cn(
            'min-w-0 rounded-lg border border-border bg-surface p-(--space-panel) [grid-area:ticket] lg:self-start',
            isLgUp && isTall && ticketFits && 'sticky top-22',
          )}
        >
          {unverified ? (
            <EmptyState icon={ShieldWarningIcon} title="Orders unavailable" headingLevel={2}>
              This token’s identity could not be verified, so AtPrice does not take orders for it.
            </EmptyState>
          ) : (
            <OrderTicket
              market={market}
              side={side}
              onSideChange={onSideChange}
              loadingReason={marketLoading ? 'Loading market data.' : null}
              undo={
                undo === null
                  ? null
                  : () => {
                      setSide(undo.side);
                      setAmountText(undo.amountText);
                      setLimit(undo.limit);
                      setUndo(null);
                    }
              }
              amount={{
                text: amountText,
                unit: amountUnit,
                error: amountError,
                balance: balanceLine,
                max,
                onChange: (text) => {
                  setAmountText(sanitizeDecimalInput(text));
                  setUndo(null);
                },
                onMax: () => {
                  if (maxValue !== null) setAmountText(unitsInputText(maxValue, amountDecimals));
                  setUndo(null);
                },
              }}
              limit={{
                text: limitInputText,
                orientation: display,
                unit: limitUnit(display, market.symbol),
                invertedUnit: limitUnit(
                  display === 'tokens_per_bch' ? 'bch_per_token' : 'tokens_per_bch',
                  market.symbol,
                ),
                error: limitError,
                reference,
                offsetValue: (bps: OffsetBps) =>
                  reference === null
                    ? null
                    : offsetLimitText(side, reference.price, bps, display, market.decimals),
                offsetLine,
                onChange: (text) => {
                  setLimit({ text: sanitizeDecimalInput(text), orientation: display });
                  setUndo(null);
                },
                onInvert: () => setDisplay(display === 'tokens_per_bch' ? 'bch_per_token' : 'tokens_per_bch'),
                onOffset: (bps) => {
                  if (reference === null) return;
                  setLimit({
                    text: offsetLimitText(side, reference.price, bps, display, market.decimals),
                    orientation: display,
                  });
                  setUndo(null);
                },
              }}
              recipient={recipientProps}
              amountRef={amountRef}
              limitRef={limitRef}
              recipientRef={recipientRef}
              fees={fees}
              statusCard={session !== null && dialogOpen ? <FundingStatusCard flow={session.flow} /> : null}
              action={placement === 'bar' ? null : action}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 [grid-area:summary]">
          <div className="rounded-lg border border-border bg-surface p-(--space-panel)">
            {apiDown ? (
              <MarketStats market={market} view={detailView} />
            ) : (
              <QuotePanel
                market={market}
                side={side}
                view={quoteView}
                limitPrice={price}
                minProceeds={terms?.minProceeds ?? null}
                lowLiquidityNote={lowLiquidityNote}
              />
            )}
          </div>
          <div className="rounded-lg border border-border bg-surface p-(--space-panel)">
            <OrderSummary market={market} side={side} terms={summaryTerms} maxNetworkFee={MAX_NETWORK_FEE} />
          </div>
          <div className="rounded-lg border border-border bg-surface p-(--space-panel)">
            <RiskList
              title="Before you fund"
              headingId="before-you-fund"
              extra={
                quoteView.kind === 'unavailable'
                  ? `No single pool can take ${quoteView.amountText} right now. Versus your limit: cannot fill at this size today.`
                  : null
              }
            />
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-border bg-surface p-(--space-panel) [grid-area:stats]">
          <MarketStats market={market} view={detailView} />
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-surface p-(--space-panel) [grid-area:history]">
          <MarketHistory market={market} fills={fillsView} />
        </div>
      </div>

      {placement === 'bar' && !unverified ? (
        <div
          ref={barRef}
          className="fixed inset-x-0 bottom-0 z-(--z-sticky) bg-surface px-(--space-gutter) pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-sticky md:px-(--space-gutter-md) lg:hidden"
        >
          {action}
        </div>
      ) : null}

      {session === null ? null : (
        <FundingDialog
          key={session.draftId}
          session={session}
          open={dialogOpen}
          wallet={dialogWallet}
          networkMismatch={
            networkCheck.status === 'mismatch'
              ? `AtPrice is misconfigured: this page is on ${networkCheck.web} but the server is on ${networkCheck.api}. Orders are paused.`
              : null
          }
          versusLine={versusLine}
          onClose={() => closeDialog(session)}
          titleRef={titleRef}
          statusRef={statusRef}
        />
      )}
    </div>
  );
}
