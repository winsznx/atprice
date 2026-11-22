'use client';

import { cauldronTradeFee, type OrderSide } from '@atprice/core';
import { CaretDownIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { formatBch, formatFee, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { CONTROL_TRANSITION } from './ui/button';

const POOL_FEE_SAMPLE = 1_000_000n;

/** The Cauldron fee as a percentage, derived from core's pool maths, not typed into the UI. */
export const poolFeePercent = (): string => formatPercent(cauldronTradeFee(POOL_FEE_SAMPLE), POOL_FEE_SAMPLE);

export const protocolFeePercent = (bps: number): string => formatPercent(BigInt(bps), 10_000n);

export interface FeeDisclosureValues {
  readonly side: OrderSide;
  /** From `GET /network`. */
  readonly protocolFeeBps: number;
  /** `estimate` in the ticket (no funding transaction yet), `exact` on the confirmation (DD 7.4). */
  readonly fundingFee:
    | {
        readonly basis: 'estimate';
        readonly sats: bigint;
        readonly bytes: number;
        readonly satsPerByte: bigint;
      }
    | {
        readonly basis: 'exact';
        readonly sats: bigint;
        readonly bytes: number;
        readonly satsPerByte: bigint;
      };
  /** `maxNetworkFee` from network config. */
  readonly maxNetworkFee: bigint;
  /** Estimated cancel fee at the current rate; never above `maxNetworkFee`. */
  readonly cancelFeeEstimate: bigint;
  /** Buy only: BCH sent back with the tokens (`BUY_PAYOUT_SATS`). */
  readonly tokenDust: bigint | null;
  /** Funding output 2: the change, or the 1,000 sat marker when the change would be smaller. */
  readonly keptForCancel: { readonly kind: 'marker' | 'change'; readonly sats: bigint };
}

interface Line {
  readonly label: string;
  readonly value: string;
  readonly explanation: string;
}

const lines = (values: FeeDisclosureValues): Line[] => {
  const about = values.fundingFee.basis === 'estimate' ? 'about ' : '';
  const result: Line[] = [
    {
      label: 'AtPrice protocol fee',
      value: protocolFeePercent(values.protocolFeeBps),
      explanation: 'No AtPrice fee during the pilot. The contract has no fee output, so none can be taken.',
    },
    {
      label: 'Cauldron pool fee',
      value: poolFeePercent(),
      explanation: 'Charged by the pool on the BCH side of the swap and already included in the rate.',
    },
    {
      label: 'Funding network fee',
      value: `${about}${formatFee(values.fundingFee.sats)}`,
      explanation: `Paid by your wallet to create the order: ${about}${values.fundingFee.bytes.toLocaleString('en-US')} bytes at ${values.fundingFee.satsPerByte.toString()} sat/byte.`,
    },
    {
      label: 'Execution network fee',
      value: `up to ${formatFee(values.maxNetworkFee)}`,
      explanation:
        values.side === 'buy'
          ? 'Taken from the order when it fills. Whatever the transaction does not need goes into your swap.'
          : 'Taken from the pool’s BCH when it fills, not from your minimum.',
    },
    {
      label: 'Cancel network fee',
      value: `about ${formatFee(values.cancelFeeEstimate)}, never more than ${formatBch(values.maxNetworkFee, 'exact')} BCH`,
      explanation: 'Taken from your refund if you cancel. The contract caps it at the network fee cap.',
    },
  ];
  if (values.tokenDust !== null) {
    result.push({
      label: 'Token dust',
      value: formatFee(values.tokenDust),
      explanation: 'Sent back to you with your tokens. A token output must carry a little BCH.',
    });
  }
  result.push({
    label: 'Kept for cancelling (not a fee)',
    value:
      values.keptForCancel.kind === 'marker'
        ? formatFee(values.keptForCancel.sats)
        : `${formatBch(values.keptForCancel.sats, 'exact')} BCH change`,
    explanation:
      'Funding output 2 pays your owner address: your change, or a 1,000 sat marker if the change would be smaller. It stays in your wallet. A cancel later spends it to prove you own the order.',
  });
  return result;
};

function FeeTable({ values }: { values: FeeDisclosureValues }) {
  return (
    <dl className="flex flex-col divide-y divide-border">
      {lines(values).map((line) => (
        <div key={line.label} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <dt className="text-label text-fg">{line.label}</dt>
            <dd className="num text-num-md text-fg">{line.value}</dd>
          </div>
          <dd className="max-w-[64ch] text-body-sm text-fg-muted">{line.explanation}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The confirmation's fee list as a table (funding-confirmation.md "Screen-reader labels"): each fee is
 * a row header with its value, and its explanation sits in a full-width row below it.
 */
function ConfirmationFeeTable({ values }: { values: FeeDisclosureValues }) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">Fees for this order</caption>
      {lines(values).map((line) => (
        <tbody key={line.label} className="border-b border-border last:border-0">
          <tr>
            <th scope="row" className="pt-3 pr-4 align-baseline text-label font-normal text-fg">
              {line.label}
            </th>
            <td className="num pt-3 text-right align-baseline text-num-md text-fg">{line.value}</td>
          </tr>
          <tr>
            <td colSpan={2} className="max-w-[64ch] pt-1 pb-3 text-body-sm text-fg-muted">
              {line.explanation}
            </td>
          </tr>
        </tbody>
      ))}
    </table>
  );
}

/** Ticket summary row text (DD 7.2 item 6). */
export const feeSummaryText = (protocolFeeBps: number, maxNetworkFee: bigint): string =>
  `Fees: protocol ${protocolFeePercent(protocolFeeBps)}, pool ${poolFeePercent()} (in the rate), network up to ${formatFee(maxNetworkFee)}`;

/**
 * DD 7.4. `variant="ticket"` is collapsed behind the summary row (M-07 disclosure); `variant="confirmation"`
 * is always fully expanded and never animated (M-07 "Must never"). Every value is `exact` mode.
 */
export function FeeDisclosure({
  values,
  variant,
}: {
  values: FeeDisclosureValues;
  variant: 'ticket' | 'confirmation';
}) {
  const [open, setOpen] = useState(false);
  if (variant === 'confirmation') {
    return (
      <section aria-labelledby="fee-disclosure-title" className="flex flex-col gap-3">
        <h3 id="fee-disclosure-title" className="text-label font-semibold text-fg">
          Fees
        </h3>
        <ConfirmationFeeTable values={values} />
      </section>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex min-h-(--size-control) w-full items-center justify-between gap-3 rounded-sm text-left text-body-sm text-fg-secondary hover:text-fg',
          CONTROL_TRANSITION,
        )}
      >
        <span className="num">{feeSummaryText(values.protocolFeeBps, values.maxNetworkFee)}</span>
        <CaretDownIcon aria-hidden="true" className={cn('size-4 shrink-0', open && 'rotate-180')} />
        <span className="sr-only">{open ? 'Hide fee details' : 'Show fee details'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-3">
          <FeeTable values={values} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
