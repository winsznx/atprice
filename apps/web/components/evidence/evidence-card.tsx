'use client';

import { SELL_ORDER_SATS } from '@atprice/core';
import { useMutation } from '@tanstack/react-query';
import { CaretDownIcon, GitDiffIcon, InfoIcon, ShieldCheckIcon, WifiSlashIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Num, Rate } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import { StatusBadge } from '@/components/status-badge';
import { orderInputAsset, orderOutputAsset, PairLogos, WithAssetLogo } from '@/components/token-logo';
import { Button, CONTROL_TRANSITION } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { EvidenceOrder, FillSettlement } from '@/lib/api/schemas';
import { getChain } from '@/lib/chain/client';
import { formatBch, formatBlockHeight, formatFee, formatSignedUnits } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import {
  aboveMinimum,
  bchText,
  fillRate,
  limitText,
  marketOf,
  minimumText,
  orderInputText,
  receivedText,
  tokenSymbol,
} from '@/lib/orders/display';
import { BCH_ASSET } from '@/lib/token-logos';
import { cn } from '@/lib/utils';
import {
  cardHeadingId,
  orderPath,
  orderTitle,
  spokenDateTime,
  verifyEvidenceOrder,
  verifyResultText,
  type VerifyResult,
} from './evidence-logic';

export const FILLED_BY_BASIS =
  'AtPrice knows only which fills its own keeper sent. A fill carries no filler identity on chain.';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-body-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-num-md text-fg">{children}</dd>
    </div>
  );
}

const aboveText = (order: EvidenceOrder, fill: FillSettlement): string => {
  const surplus = aboveMinimum(order, fill.received);
  const market = marketOf(order.tokenCategory);
  const decimals = order.side === 'buy' ? (market?.decimals ?? 0) : 8;
  const unit = order.side === 'buy' ? (market?.symbol ?? 'units') : 'BCH';
  return `${formatSignedUnits(surplus, decimals, 'exact')} ${unit} above`;
};

function FilledByInfo() {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Why Filled by is known"
        className={cn(
          'inline-flex size-9 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken hover:text-fg',
          CONTROL_TRANSITION,
        )}
      >
        <InfoIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverContent className="max-w-[18rem] text-body-sm text-fg-secondary">
        {FILLED_BY_BASIS}
      </PopoverContent>
    </Popover>
  );
}

function FeeFields({ order }: { order: EvidenceOrder }) {
  const settlement = order.settlement;
  return (
    <>
      {settlement.kind === 'fill' ? (
        <Field label="Pool fee">
          <Num>{formatFee(settlement.poolFeeSats)}</Num>
        </Field>
      ) : null}
      <Field label="Network fee">
        <Num>{formatFee(settlement.networkFeeSats)}</Num>
      </Field>
      <Field label="AtPrice fee">
        <Num>{`${formatBch(0n, 'exact')} BCH`}</Num>
      </Field>
    </>
  );
}

function TermFields({ order }: { order: EvidenceOrder }) {
  const settlement = order.settlement;
  const limit = limitText(order);
  if (settlement.kind === 'fill') {
    const filledAt = fillRate(order, settlement);
    const market = marketOf(order.tokenCategory);
    return (
      <>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Field label="Paid">
            <WithAssetLogo asset={orderInputAsset(order)}>
              <Num>{orderInputText(order, 'exact')}</Num>
            </WithAssetLogo>
          </Field>
          <span aria-hidden="true" className="text-fg-muted">
            →
          </span>
          <Field label="Received">
            <WithAssetLogo asset={orderOutputAsset(order)}>
              <Num>{receivedText(order, settlement.received, 'exact')}</Num>
            </WithAssetLogo>
          </Field>
          <Field label="Minimum was">
            <Num>{`${minimumText(order, 'exact')} (${aboveText(order, settlement)})`}</Num>
          </Field>
        </div>
        {order.side === 'sell' ? (
          <p className="text-body-sm text-fg-muted">
            {`${formatBch(settlement.received - SELL_ORDER_SATS, 'exact')} BCH for the tokens + ${SELL_ORDER_SATS.toLocaleString('en-US')} sat reserve returned`}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Field label="Limit">
            {limit === null ? <span className="text-fg-muted">Not available</span> : <Num>{limit}</Num>}
          </Field>
          <Field label="Filled at">
            {filledAt === null ? (
              <span className="text-fg-muted">Not available</span>
            ) : (
              <Rate
                numerator={filledAt.numerator}
                denominator={filledAt.denominator}
                unit={`${market?.symbol ?? ''} per BCH`}
                term
              />
            )}
          </Field>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Field label="Paid">
          <WithAssetLogo asset={orderInputAsset(order)}>
            <Num>{orderInputText(order, 'exact')}</Num>
          </WithAssetLogo>
        </Field>
        <Field label="Refunded">
          <span className="flex flex-col">
            {order.side === 'sell' && settlement.refundTokens > 0n ? (
              <WithAssetLogo asset={order.tokenCategory}>
                <Num>{orderInputText({ ...order, amount: settlement.refundTokens }, 'exact')}</Num>
              </WithAssetLogo>
            ) : null}
            <WithAssetLogo asset={BCH_ASSET}>
              <Num>{bchText(settlement.refundSats, 'exact')}</Num>
            </WithAssetLogo>
          </span>
        </Field>
        <Field label="Minimum was">
          <Num>{minimumText(order, 'exact')}</Num>
        </Field>
      </div>
      <Field label="Limit">
        {limit === null ? <span className="text-fg-muted">Not available</span> : <Num>{limit}</Num>}
      </Field>
    </>
  );
}

function TxRow({ label, txid, height }: { label: string; txid: string; height: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <dt className="w-16 text-body-sm text-fg-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <HashChip value={txid} kind="tx" label={`${label} transaction id ${txid}`} />
        <span className="text-body-sm text-fg-secondary">
          block <span className="num">{formatBlockHeight(height)}</span>
        </span>
      </dd>
    </div>
  );
}

const VERIFY_STYLE = {
  confirmed: {
    icon: ShieldCheckIcon,
    className: 'bg-status-filled-subtle text-fg',
    iconClass: 'text-status-filled',
  },
  mismatch: {
    icon: GitDiffIcon,
    className: 'bg-status-review-subtle text-fg',
    iconClass: 'text-status-review',
  },
  unreachable: {
    icon: WifiSlashIcon,
    className: 'bg-surface-sunken text-fg-secondary',
    iconClass: 'text-fg-muted',
  },
} as const;

export function VerifyLine({ result }: { result: VerifyResult }) {
  const style = VERIFY_STYLE[result.kind];
  const Icon = style.icon;
  return (
    <p className={cn('flex gap-2 rounded-md p-3 text-body-sm', style.className)}>
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', style.iconClass)} />
      <span>
        {verifyResultText(result)}
        {result.kind === 'unreachable' ? <span className="hash ml-2 text-mono-sm">{result.code}</span> : null}
      </span>
    </p>
  );
}

function CardHeading({ order, headingId }: { order: EvidenceOrder; headingId: string }) {
  const hydrated = useNow() !== null;
  const settled = order.settlement.kind === 'fill' ? 'Filled' : 'Cancelled';
  return (
    <h2 className="min-w-0 scroll-mt-20 text-label font-semibold text-fg" id={`${headingId}-title`}>
      <Link
        id={headingId}
        href={orderPath(order)}
        className={cn(
          'inline-flex min-h-(--size-control) flex-wrap items-center gap-x-3 underline-offset-4 hover:underline',
          CONTROL_TRANSITION,
        )}
        aria-label={`${settled}: ${orderTitle(order).replace(/^(Buy|Sell)/, (word) => word.toLowerCase())}, ${spokenDateTime(order.settlementBlock.time, hydrated)}`}
      >
        <span className="inline-flex items-center gap-1.5">
          <PairLogos tokenCategory={order.tokenCategory} symbol={tokenSymbol(order.tokenCategory)} />
          <span className="text-body">{orderTitle(order)}</span>
        </span>
        <span className="text-caption font-medium text-fg-muted">
          <LocalTime iso={order.settlementBlock.time} withDate />
        </span>
      </Link>
    </h2>
  );
}

const focusHeading = (id: string, scroll: boolean): void => {
  const element = document.getElementById(id);
  if (element === null) return;
  // motion.md "Not animated": the `?order=` card is reached in one frame.
  if (scroll) element.scrollIntoView({ behavior: 'auto', block: 'start' });
  element.focus({ preventScroll: scroll });
};

/** One completed order as a receipt a judge can compare against an explorer (evidence.md, DD 4 `exact`). */
export function EvidenceCard({
  order,
  feesOpen = false,
  focus,
}: {
  order: EvidenceOrder;
  feesOpen?: boolean | undefined;
  /** `scroll`: the `?order=` target, scrolled to and focused; `focus`: first card after `Load older`. */
  focus?: 'scroll' | 'focus' | undefined;
}) {
  const headingId = cardHeadingId(order);
  const liveId = useId();
  const [mobileFeesOpen, setMobileFeesOpen] = useState(feesOpen);
  const verify = useMutation({ mutationFn: () => verifyEvidenceOrder(getChain(), order) });
  const settlement = order.settlement;
  useEffect(() => {
    if (focus !== undefined) focusHeading(headingId, focus === 'scroll');
  }, [focus, headingId]);
  const verifyButton = (
    <Button
      variant="outline"
      size="compact"
      onClick={() => verify.mutate()}
      aria-busy={verify.isPending || undefined}
      aria-disabled={verify.isPending || undefined}
    >
      {verify.isPending ? 'Checking' : 'Verify on chain'}
    </Button>
  );

  return (
    <article
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-(--space-panel)"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <StatusBadge status={settlement.kind === 'fill' ? 'FILLED' : 'CANCELLED'} />
          <CardHeading order={order} headingId={headingId} />
        </div>
        <div className="hidden md:block">{verifyButton}</div>
      </div>

      <dl className="flex flex-col gap-3">
        <TermFields order={order} />
        <div className="hidden flex-wrap gap-x-6 gap-y-2 md:flex">
          <FeeFields order={order} />
        </div>
        {settlement.kind === 'fill' ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Field label="Pool">
              <HashChip
                value={`${settlement.poolOutpoint.txid}:${settlement.poolOutpoint.vout}`}
                kind="outpoint"
                label={`Pool outpoint ${settlement.poolOutpoint.txid}:${settlement.poolOutpoint.vout}`}
              />
            </Field>
            <Field label="Pool owner">
              <HashChip
                value={settlement.poolPkh}
                kind="keyhash"
                label={`Pool owner key hash ${settlement.poolPkh}`}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-x-2">
              <dt className="text-body-sm text-fg-muted">Filled by</dt>
              <dd className="flex items-center gap-1 text-body-sm text-fg">
                {settlement.filledBy === 'atprice_keeper'
                  ? 'AtPrice’s keeper'
                  : 'Another filler, not AtPrice’s keeper'}
                <FilledByInfo />
              </dd>
            </div>
          </div>
        ) : null}
        <TxRow label="Funding" txid={order.funding.txid} height={order.fundingBlock.height} />
        <TxRow
          label={settlement.kind === 'fill' ? 'Fill' : 'Cancel'}
          txid={settlement.txid}
          height={order.settlementBlock.height}
        />
      </dl>

      <div aria-live="polite" id={liveId}>
        {verify.data === undefined ? null : <VerifyLine result={verify.data} />}
        {verify.isError ? (
          <VerifyLine
            result={{
              kind: 'unreachable',
              host: 'the Electrum server',
              code: verify.error instanceof Error ? verify.error.name : 'VERIFY_FAILED',
            }}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        <div>{verifyButton}</div>
        <Collapsible open={mobileFeesOpen} onOpenChange={setMobileFeesOpen}>
          <CollapsibleTrigger
            className={cn(
              'inline-flex min-h-(--size-control) items-center gap-2 text-label font-semibold text-fg',
              CONTROL_TRANSITION,
            )}
          >
            Fees
            <CaretDownIcon
              aria-hidden="true"
              className={cn('size-4', mobileFeesOpen ? 'rotate-180' : undefined)}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="flex flex-col gap-2 pt-2">
              <FeeFields order={order} />
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </article>
  );
}
