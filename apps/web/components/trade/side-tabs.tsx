'use client';

import type { OrderSide } from '@atprice/core';
import { ArrowCircleDownLeftIcon, ArrowCircleUpRightIcon } from '@phosphor-icons/react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { CONTROL_TRANSITION } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * DD 7.2 item 1 and motion.md M-06: a two-segment tablist whose white plate and 2px side-coloured bar
 * travel with `transform`; the form switches on the click and only the plate moves. One tab stop,
 * arrows switch (Radix automatic activation). The form is the active tab's panel.
 */
export function SideTabs({
  side,
  symbol,
  onSideChange,
  disabledReasonId,
  children,
}: {
  side: OrderSide;
  symbol: string;
  onSideChange: (side: OrderSide) => void;
  /** Set while the market loads: the tabs stay focusable and point at the reason. */
  disabledReasonId: string | null;
  children: ReactNode;
}) {
  const disabled = disabledReasonId !== null;
  return (
    <TabsPrimitive.Root
      value={side}
      onValueChange={(value) => {
        if (!disabled && (value === 'buy' || value === 'sell')) onSideChange(value);
      }}
      className="flex min-w-0 flex-col gap-4"
    >
      <TabsPrimitive.List
        aria-label="Order side"
        aria-describedby={disabledReasonId ?? undefined}
        className="relative grid min-h-(--size-control) grid-cols-2 rounded-md bg-surface-muted p-1"
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-sm bg-surface shadow-inset',
            'motion-safe:transition-transform motion-safe:duration-(--duration-base) ease-move',
            side === 'sell' ? 'translate-x-full' : 'translate-x-0',
          )}
        >
          <span
            className={cn(
              'absolute inset-x-2 bottom-0 h-0.5 rounded-full',
              side === 'buy' ? 'bg-buy' : 'bg-sell',
              CONTROL_TRANSITION,
            )}
          />
        </span>
        {(['buy', 'sell'] as const).map((value) => {
          const Icon = value === 'buy' ? ArrowCircleDownLeftIcon : ArrowCircleUpRightIcon;
          const selected = side === value;
          return (
            <TabsPrimitive.Trigger
              key={value}
              value={value}
              aria-disabled={disabled || undefined}
              aria-label={value === 'buy' ? `Buy ${symbol}, spend BCH` : `Sell ${symbol}, receive BCH`}
              className={cn(
                'relative z-10 inline-flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-sm px-2 text-center text-label font-semibold break-words',
                CONTROL_TRANSITION,
                selected ? (value === 'buy' ? 'text-buy' : 'text-sell') : 'text-fg-muted hover:text-fg',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0">{value === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`}</span>
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
      <TabsPrimitive.Content
        value={side}
        className="flex min-w-0 flex-col gap-4 focus-visible:outline-none"
        tabIndex={-1}
      >
        {children}
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}
