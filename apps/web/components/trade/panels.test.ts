import { SUPPORTED_MARKETS } from '@atprice/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Quote } from '@/lib/api/schemas';
import { confirmReason, statusHeading } from '../funding/funding-dialog';
import type { FundingPhase } from '../funding/flow';
import { OrderSummary, typedLimitText } from './order-summary';
import { impactSeverity, QuotePanel, type QuoteView } from './quote-panel';
import { RISK_LINES, RiskList } from './risk-list';

const market = SUPPORTED_MARKETS.chipnet[0];
if (market === undefined) throw new Error('chipnet allowlist is empty');

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const quote: Quote = {
  side: 'buy',
  amountIn: 50_000_000n,
  amountOut: 22_480n,
  effectiveRate: { numerator: 10_000_000_000n, denominator: 4_496_000n },
  priceImpact: { numerator: 42n, denominator: 10_000n },
  pool: { outpoint: { txid: '9e'.repeat(32), vout: 0 }, ownerPkh: '22'.repeat(20) },
  poolsChecked: 4,
  blockHeight: 925_114,
  calculatedAt: '2026-11-22T14:02:11Z',
  expiresAt: '2026-11-22T14:02:26Z',
};

const renderQuote = (view: QuoteView, minProceeds: bigint | null = 23_000n) =>
  text(
    renderToStaticMarkup(
      createElement(QuotePanel, {
        market,
        side: 'buy',
        view,
        limitPrice: { numerator: 10_000_000_000n, denominator: 4_600_000n },
        minProceeds,
        lowLiquidityNote: null,
      }),
    ),
  );

describe('QuotePanel states', () => {
  it('shows the quote in compact mode with the gap to the limit', () => {
    const html = renderQuote({ kind: 'ready', quote, updating: false, stale: false });
    expect([
      html.includes('224.80 PUSDTEST'),
      html.includes('449.6 PUSDTEST per BCH') || html.includes('449.60 PUSDTEST per BCH'),
      html.includes('Needs a 2.31% better rate'),
      html.includes('of 4 pools checked'),
    ]).toEqual([true, true, true, true]);
  });

  it('says the limit is reachable when the pool pays the minimum', () => {
    expect(renderQuote({ kind: 'ready', quote, updating: false, stale: false }, 22_000n)).toContain(
      'Your limit is reachable now',
    );
  });

  it('marks a stale quote', () => {
    expect(renderQuote({ kind: 'ready', quote, updating: false, stale: true })).toContain('Stale');
  });

  it('keeps old values while updating', () => {
    expect(renderQuote({ kind: 'ready', quote, updating: true, stale: false })).toContain('Updating');
  });

  it('names the no-pool state', () => {
    expect(renderQuote({ kind: 'unavailable', amountText: '40 BCH', code: 'no_liquidity' })).toContain(
      'No single pool can take 40 BCH right now. Versus your limit Cannot fill at this size today.',
    );
  });

  it('shows a failed quote by its code', () => {
    expect(
      renderQuote({ kind: 'error', code: 'API_RESPONSE_INVALID', message: 'bad', retry: () => undefined }),
    ).toContain('API_RESPONSE_INVALID');
  });
});

describe('impactSeverity (DD 7.3)', () => {
  it('has no word under 1%, High from 1% and Very high from 5%', () => {
    expect([
      impactSeverity({ numerator: 99n, denominator: 10_000n }),
      impactSeverity({ numerator: 1n, denominator: 100n }),
      impactSeverity({ numerator: 5n, denominator: 100n }),
    ]).toEqual(['none', 'high', 'very_high']);
  });
});

describe('OrderSummary', () => {
  it('locks spend + fee cap + token dust for a buy, every amount exact', () => {
    const html = text(
      renderToStaticMarkup(
        createElement(OrderSummary, {
          market,
          side: 'buy',
          maxNetworkFee: 2_000n,
          terms: { amount: 50_000_000n, minOut: 23_000n, minProceeds: 23_000n, limitTokensPerBch: '460.00' },
        }),
      ),
    );
    expect([
      html.includes('0.50003000 BCH'),
      html.includes('0.50000000 BCH order + 0.00002000 BCH network fee cap + 0.00001000 BCH token dust'),
      html.includes('230.00 PUSDTEST'),
      html.includes('1 BCH buys 460.00 PUSDTEST or more'),
    ]).toEqual([true, true, true, true]);
  });

  it('shows a sell’s proceeds P, never the raw minOut (DD 4.1)', () => {
    const html = text(
      renderToStaticMarkup(
        createElement(OrderSummary, {
          market,
          side: 'sell',
          maxNetworkFee: 2_000n,
          terms: {
            amount: 125_000n,
            minOut: 250_002_000n,
            minProceeds: 250_000_000n,
            limitTokensPerBch: '500',
          },
        }),
      ),
    );
    expect([html.includes('2.50000000 BCH'), html.includes('2.50002000')]).toEqual([true, false]);
  });

  it('asks for terms before they exist', () => {
    const html = text(
      renderToStaticMarkup(
        createElement(OrderSummary, { market, side: 'buy', maxNetworkFee: 2_000n, terms: null }),
      ),
    );
    expect(html).toContain('Enter an amount and a limit price');
  });

  it('groups the typed limit and changes nothing else', () => {
    expect([typedLimitText('12500.50'), typedLimitText('0460')]).toEqual(['12,500.50', '460']);
  });
});

describe('RiskList', () => {
  it('always lists every line of how an order works', () => {
    const html = renderToStaticMarkup(
      createElement(RiskList, { title: 'How your order works', headingId: 'risk' }),
    );
    expect(RISK_LINES.every((line) => text(html).includes(text(line)))).toBe(true);
  });
});

describe('funding dialog status', () => {
  const review: FundingPhase = {
    kind: 'review',
    draft: null,
    shortfall: { needed: 60_000_000n, available: 50_000_000n },
    coinsChanged: false,
    updated: [],
    stoppedWaiting: false,
  };

  it('names each state by its heading', () => {
    expect([
      statusHeading({ kind: 'building' }, false),
      statusHeading({ ...review, coinsChanged: true }, false),
      statusHeading({ kind: 'broadcast_rejected', message: 'x' }, false),
      statusHeading(review, true),
    ]).toEqual(['Building the transaction', 'Coins changed', 'Funding failed', 'Wallet disconnected']);
  });

  it('blocks confirm when the balance no longer covers the order', () => {
    expect(confirmReason(review, { kind: 'connected' }, null, '0:00')).toBe(
      'Your balance changed and no longer covers this order (0.60000000 BCH needed, 0.50000000 BCH available).',
    );
  });

  it('blocks confirm while the wallet reconnects', () => {
    expect(confirmReason(review, { kind: 'reconnecting', since: 0 }, null, '0:07')).toBe(
      'Reconnecting to your wallet (0:07). Requests resume when it answers.',
    );
  });
});
