import type { OrderSide } from '@atprice/core';
import type { ReactNode } from 'react';
import { tokenSymbol } from '@/lib/orders/display';
import { BCH_ASSET, tokenLogoSrc } from '@/lib/token-logos';
import { cn } from '@/lib/utils';

export type TokenLogoSize = 16 | 20 | 24 | 32;

const BOX: Readonly<Record<TokenLogoSize, string>> = {
  16: 'size-4',
  20: 'size-5',
  24: 'size-6',
  32: 'size-8',
};

/** Two letters have to fit inside the circle, so the monogram scales with it. */
const MONOGRAM_TEXT: Readonly<Record<TokenLogoSize, string>> = {
  16: 'text-[0.4375rem]',
  20: 'text-[0.5625rem]',
  24: 'text-[0.6875rem]',
  32: 'text-[0.875rem]',
};

const CIRCLE = 'inline-block shrink-0 rounded-full ring-1 ring-border';

/**
 * DD 12 asset logo, always printed before the asset's symbol. The symbol sits next to it, so the image
 * is decorative (`alt=""`). It is an `<img>`, never inlined: `bch.svg` carries an inline `<style>`, and
 * `res.svg` sizes itself in millimetres, so the rendered size always comes from CSS. An asset without
 * a vendored official logo gets a neutral monogram, never another token's logo.
 */
export function TokenLogo({
  asset,
  symbol,
  size = 16,
  className,
}: {
  /** The token category, or `BCH_ASSET` for native BCH. */
  asset: string;
  symbol: string;
  size?: TokenLogoSize | undefined;
  className?: string | undefined;
}) {
  const src = tokenLogoSrc(asset);
  if (src === undefined) {
    return (
      <span
        aria-hidden="true"
        title="No official logo"
        className={cn(
          CIRCLE,
          BOX[size],
          MONOGRAM_TEXT[size],
          'inline-flex items-center justify-center bg-surface-sunken font-sans leading-none font-semibold text-fg-secondary',
          className,
        )}
      >
        {Array.from(symbol).slice(0, 2).join('')}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a vendored SVG at a fixed size; next/image would only add a loader and inline style
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      decoding="async"
      className={cn(CIRCLE, BOX[size], 'bg-surface object-contain', className)}
    />
  );
}

export function BchLogo({
  size,
  className,
}: {
  size?: TokenLogoSize | undefined;
  className?: string | undefined;
}) {
  return <TokenLogo asset={BCH_ASSET} symbol="BCH" size={size} className={className} />;
}

/** The BCH and token logos before a `BCH / PUSD` pair name, in the pair's order. */
export function PairLogos({
  tokenCategory,
  symbol,
  size = 16,
  className,
}: {
  tokenCategory: string;
  symbol: string;
  size?: TokenLogoSize | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)}>
      <BchLogo size={size} />
      <TokenLogo asset={tokenCategory} symbol={symbol} size={size} className="-ml-1" />
    </span>
  );
}

interface OrderAssets {
  readonly side: OrderSide;
  readonly tokenCategory: string;
}

/** What an order puts in: BCH for a buy, its token for a sell. */
export const orderInputAsset = (order: OrderAssets): string =>
  order.side === 'buy' ? BCH_ASSET : order.tokenCategory;

/** What an order pays out: its token for a buy, BCH for a sell. */
export const orderOutputAsset = (order: OrderAssets): string =>
  order.side === 'buy' ? order.tokenCategory : BCH_ASSET;

/** An amount or label that names one asset, with that asset's logo before it. */
export function WithAssetLogo({
  asset,
  size,
  className,
  children,
}: {
  /** The token category, or `BCH_ASSET` for native BCH. */
  asset: string;
  size?: TokenLogoSize | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <TokenLogo asset={asset} symbol={asset === BCH_ASSET ? 'BCH' : tokenSymbol(asset)} size={size} />
      {children}
    </span>
  );
}
