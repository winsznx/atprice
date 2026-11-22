import { SELL_ORDER_SATS } from '@atprice/core';
import { InfoIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import type { CancelSettlement, FillSettlement, Order } from '@/lib/api/schemas';
import { formatBch, formatBlockHeight, formatFee, formatPercent, formatSignedUnits } from '@/lib/format';
import {
  aboveMinimum,
  bchText,
  displayMinimum,
  fillRate,
  limitText,
  marketOf,
  minimumText,
  orderInputText,
  receivedText,
} from '@/lib/orders/display';
import { BCH_ASSET } from '@/lib/token-logos';
import { Num, Rate } from './amount';
import { HashChip } from './hash-chip';
import { StatusBadge } from './status-badge';
import { orderInputAsset, orderOutputAsset, WithAssetLogo } from './token-logo';

function Row({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: ReactNode | undefined;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <dt className="text-body-sm text-fg-muted">{label}</dt>
        <dd className="min-w-0 text-right text-num-md text-fg">{children}</dd>
      </div>
      {note === undefined ? null : <dd className="text-body-sm text-fg-muted">{note}</dd>}
    </div>
  );
}

const confirmationsText = (confirmations: number, blockHeight: number | null): string =>
  confirmations === 0 || blockHeight === null
    ? 'Not yet confirmed'
    : `${confirmations.toLocaleString('en-US')} ${confirmations === 1 ? 'confirmation' : 'confirmations'}, block ${formatBlockHeight(blockHeight)}`;

function FilledRows({ order, fill }: { order: Order; fill: FillSettlement }) {
  const market = marketOf(order.tokenCategory);
  const surplus = aboveMinimum(order, fill.received);
  const minimum = displayMinimum(order);
  const decimals = order.side === 'buy' ? (market?.decimals ?? 0) : 8;
  const unit = order.side === 'buy' ? (market?.symbol ?? 'units') : 'BCH';
  const base = minimum.kind === 'tokens' ? minimum.units : minimum.kind === 'sats' ? minimum.sats : null;
  const percent = base === null || base === 0n ? null : formatPercent(surplus, base, { signed: true });
  const limit = limitText(order);
  const proceeds = order.side === 'sell' ? fill.received - SELL_ORDER_SATS : null;
  const filledAt = fillRate(order, fill);
  return (
    <>
      <Row label="You paid">
        <WithAssetLogo asset={orderInputAsset(order)}>
          <Num>{orderInputText(order, 'exact')}</Num>
        </WithAssetLogo>
      </Row>
      <Row
        label="You received"
        note={
          proceeds === null
            ? undefined
            : `${formatBch(proceeds, 'exact')} BCH for your tokens + ${SELL_ORDER_SATS.toLocaleString('en-US')} sat reserve returned`
        }
      >
        <WithAssetLogo asset={orderOutputAsset(order)} size={24}>
          <Num size="lg">{receivedText(order, fill.received, 'exact')}</Num>
        </WithAssetLogo>
      </Row>
      <Row label="Your minimum was">
        <Num>{minimumText(order, 'exact')}</Num>
      </Row>
      <Row label="Above your minimum">
        <Num>{`${formatSignedUnits(surplus, decimals, 'exact')} ${unit}${percent === null ? '' : ` (${percent})`}`}</Num>
      </Row>
      <Row label="Your limit">
        {limit === null ? <span className="text-fg-muted">Not available</span> : <Num>{limit}</Num>}
      </Row>
      <Row label="Filled at">
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
      </Row>
      <Row label="Pool fee">
        <Num>{formatFee(fill.poolFeeSats)}</Num>
      </Row>
      <Row label="Network fee">
        <Num>{formatFee(fill.networkFeeSats)}</Num>
      </Row>
      <Row label="AtPrice fee" note="The contract has no fee output.">
        <Num>{`${formatBch(0n, 'exact')} BCH`}</Num>
      </Row>
      <Row label="Pool used">
        <HashChip value={`${fill.poolOutpoint.txid}:${fill.poolOutpoint.vout}`} kind="outpoint" />
      </Row>
      <Row label="Pool owner">
        <HashChip value={fill.poolPkh} kind="keyhash" label={`Pool owner key hash ${fill.poolPkh}`} />
      </Row>
      <Row
        label="Filled by"
        note={
          <span className="inline-flex items-start gap-1">
            <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            AtPrice knows only which fills its own keeper sent.
          </span>
        }
      >
        {fill.filledBy === 'atprice_keeper' ? 'AtPrice’s keeper' : 'Another filler, not AtPrice’s keeper'}
      </Row>
      <Row label="Settlement">
        <HashChip value={fill.txid} kind="tx" />
      </Row>
      <Row label="Confirmations">
        <Num>{confirmationsText(fill.confirmations, fill.blockHeight)}</Num>
      </Row>
    </>
  );
}

function CancelledRows({ order, cancel }: { order: Order; cancel: CancelSettlement }) {
  return (
    <>
      <Row label="Refunded">
        <span className="flex flex-col items-end">
          {order.side === 'sell' && cancel.refundTokens > 0n ? (
            <WithAssetLogo asset={order.tokenCategory}>
              <Num>{orderInputText({ ...order, amount: cancel.refundTokens }, 'exact')}</Num>
            </WithAssetLogo>
          ) : null}
          <WithAssetLogo asset={BCH_ASSET}>
            <Num>{bchText(cancel.refundSats, 'exact')}</Num>
          </WithAssetLogo>
        </span>
      </Row>
      <Row label="Network fee">
        <Num>{formatFee(cancel.networkFeeSats)}</Num>
      </Row>
      <Row label="Refund address">
        <HashChip value={cancel.refundAddress} kind="address" />
      </Row>
      <Row label="Authorized by">
        {cancel.authorizedBy === 'cancel'
          ? 'A coin at your owner address (cancel)'
          : 'Your wallet’s signature in the contract (cancelWithSig)'}
      </Row>
      <Row label="Cancel transaction">
        <HashChip value={cancel.txid} kind="tx" />
      </Row>
      <Row label="Confirmations">
        <Num>{confirmationsText(cancel.confirmations, cancel.blockHeight)}</Num>
      </Row>
    </>
  );
}

/**
 * DD 7.7 receipt. Every value is read from the settlement transaction as the API decoded it; nothing
 * comes from the original quote. Amounts are `exact`, rates go through `formatRate` with `term: true`.
 */
export function TransactionReceipt({ order, id = 'receipt' }: { order: Order; id?: string | undefined }) {
  const settlement = order.settlement;
  if (settlement === null) return null;
  const filled = settlement.kind === 'fill';
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 rounded-lg border border-border p-5 lg:p-6"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={`${id}-title`} className="font-display text-heading-3 text-fg">
          {filled ? 'Filled' : 'Cancelled'}
        </h2>
        <StatusBadge status={filled ? 'FILLED' : 'CANCELLED'} />
      </div>
      <dl className="mt-3">
        {settlement.kind === 'fill' ? (
          <FilledRows order={order} fill={settlement} />
        ) : (
          <CancelledRows order={order} cancel={settlement} />
        )}
      </dl>
    </section>
  );
}
