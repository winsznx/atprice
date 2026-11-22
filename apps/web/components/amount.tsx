import {
  formatBch,
  formatFee,
  formatRate,
  formatSignedUnits,
  formatToken,
  type AmountMode,
} from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * Every number on screen goes through these components (DD 4): tabular lining numerals, exact bigint
 * formatting, units in the visible text so the accessible name already carries them.
 */

type NumSize = 'xl' | 'lg' | 'md' | 'sm' | 'inherit';

const SIZE: Readonly<Record<NumSize, string>> = {
  xl: 'text-num-xl',
  lg: 'text-num-lg',
  md: 'text-num-md',
  sm: 'text-num-sm',
  inherit: '',
};

export function Num({
  children,
  size = 'inherit',
  className,
}: {
  children: string;
  size?: NumSize | undefined;
  className?: string | undefined;
}) {
  return <span className={cn('num font-sans', SIZE[size], className)}>{children}</span>;
}

/** A BCH amount in satoshis, shown in BCH with its unit. */
export function BchAmount({
  sats,
  mode,
  size,
  className,
}: {
  sats: bigint;
  mode: AmountMode;
  size?: NumSize | undefined;
  className?: string | undefined;
}) {
  return <Num size={size} className={className}>{`${formatBch(sats, mode)} BCH`}</Num>;
}

/** A token amount in base units at its verified decimals, with its symbol. */
export function TokenAmount({
  units,
  decimals,
  symbol,
  mode,
  size,
  className,
}: {
  units: bigint;
  decimals: number;
  symbol: string;
  mode: AmountMode;
  size?: NumSize | undefined;
  className?: string | undefined;
}) {
  return <Num size={size} className={className}>{`${formatToken(units, decimals, mode)} ${symbol}`}</Num>;
}

/** Fee line: exact BCH plus sats below 0.001 BCH (DD 4 "Fee lines"). */
export function FeeAmount({
  sats,
  prefix,
  size,
  className,
}: {
  sats: bigint;
  prefix?: string | undefined;
  size?: NumSize | undefined;
  className?: string | undefined;
}) {
  return (
    <Num
      size={size}
      className={className}
    >{`${prefix === undefined ? '' : `${prefix} `}${formatFee(sats)}`}</Num>
  );
}

/** Signed amount with `+` or U+2212 minus (DD 4 "Other rules"). */
export function SignedAmount({
  units,
  decimals,
  unit,
  mode,
  size,
  className,
}: {
  units: bigint;
  decimals: number;
  unit: string;
  mode: AmountMode;
  size?: NumSize | undefined;
  className?: string | undefined;
}) {
  return <Num size={size} className={className}>{`${formatSignedUnits(units, decimals, mode)} ${unit}`}</Num>;
}

/**
 * A derived rate (DD 4 "Rates"). For an order term whose rounding changed the value, the `≈` is
 * aria-hidden next to a visually hidden "about", so it is read as "about 452.20345".
 */
export function Rate({
  numerator,
  denominator,
  unit,
  term = false,
  size,
  className,
}: {
  numerator: bigint;
  denominator: bigint;
  unit: string;
  term?: boolean | undefined;
  size?: NumSize | undefined;
  className?: string | undefined;
}) {
  const rate = formatRate(numerator, denominator, { term });
  return (
    <span className={cn('num font-sans', size === undefined ? '' : SIZE[size], className)}>
      {rate.approximate ? (
        <>
          <span aria-hidden="true">≈ </span>
          <span className="sr-only">about </span>
        </>
      ) : null}
      {`${rate.value} ${unit}`}
    </span>
  );
}
