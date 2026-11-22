import { WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceCard, VerifyLine } from '@/components/evidence/evidence-card';
import { evidenceOrder } from '@/components/evidence/evidence.fixtures';
import { AvailabilityBadge, ChangeValue, VolumeValue } from '@/components/markets/market-bits';
import { MarketCards, MarketsTable } from '@/components/markets/markets-list';
import type { MarketSummary } from '@/lib/api/schemas';
import { RecentTransactionsTable, paidReceived } from './recent-transactions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const render = (element: ReactElement): string =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, element));

/** Text a person reads or hears, without markup. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const market = (overrides: Partial<MarketSummary> = {}): MarketSummary => ({
  slug: 'bch-pusdtest',
  tokenId: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
  symbol: 'PUSDTEST',
  name: 'ParyonUSD (chipnet-16)',
  decimals: 2,
  verified: true,
  spotRate: { value: { numerator: 221n, denominator: 1n } },
  change24h: { value: null, reason: 'less than 24 hours of observations' },
  liquidity: { sats: 2_741_000_000n, tokens: 1_240_255n },
  poolCount: 4,
  volume24h: { value: null, reason: 'Cauldron indexer does not report volume' },
  availability: 'open',
  availabilityReason: null,
  minOrder: { buy: 50_000n, sell: 10n },
  observedAt: '2026-11-22T14:02:11.000Z',
  blockHeight: 925_114,
  ...overrides,
});

describe('landing recent transactions', () => {
  it('shows each completed order with its result, compact amounts, block and settlement txid', () => {
    const html = render(createElement(RecentTransactionsTable, { orders: [evidenceOrder()] }));
    const visible = text(html);
    expect(visible).toContain('Recent completed AtPrice orders on chipnet');
    expect(visible).toContain('Filled');
    expect(visible).toContain('0.05 BCH → to 22.61 PUSDTEST');
    expect(visible).toContain('925,110');
    expect(html).toContain('a1a1a1a1');
  });

  it('reads a cancel as what came back', () => {
    const order = evidenceOrder({
      status: 'CANCELLED',
      settlement: {
        kind: 'cancel',
        txid: 'c'.repeat(64),
        blockHeight: 1,
        confirmations: 1,
        refundSats: 4_999_600n,
        refundTokens: 0n,
        networkFeeSats: 400n,
        refundAddress: 'bchtest:x',
        authorizedBy: 'cancel',
      },
    });
    expect(paidReceived(order)).toEqual({ paid: '0.05 BCH', received: '0.049996 BCH refunded' });
  });
});

describe('evidence card', () => {
  it('is a receipt in exact mode with pool, owner, filler and both transactions', () => {
    const visible = text(render(createElement(EvidenceCard, { order: evidenceOrder() })));
    for (const expected of [
      'Paid 0.05000000 BCH',
      'Received 22.61 PUSDTEST',
      'Minimum was 22.50 PUSDTEST (+0.11 PUSDTEST above)',
      'Pool fee 0.00015000 BCH (15,000 sat)',
      'AtPrice fee 0.00000000 BCH',
      'Filled by AtPrice’s keeper',
      'Funding',
      'block 925,101',
      'Verify on chain',
    ]) {
      expect(visible).toContain(expected);
    }
  });

  it('names the card heading for screen readers', () => {
    const html = render(createElement(EvidenceCard, { order: evidenceOrder() }));
    expect(html).toContain('aria-label="Filled: buy PUSDTEST on BCH / PUSDTEST, 22 November 2026, 13:58 UTC"');
  });

  it('shows a mismatch in review style, never hidden', () => {
    const html = render(
      createElement(VerifyLine, { result: { kind: 'mismatch', host: 'e.test:1', differences: ['the pool owner key hash differs'] } }),
    );
    expect(html).toContain('bg-status-review-subtle');
    expect(text(html)).toBe('e.test:1 reports something different: the pool owner key hash differs.');
  });
});

describe('markets list', () => {
  it('renders the table with caption, sort state, short liquidity and its exact accessible value', () => {
    const html = render(
      createElement(MarketsTable, {
        markets: [market()],
        sort: { key: 'liquidity', dir: 'desc' },
        onSort: () => undefined,
        networkMismatch: false,
      }),
    );
    expect(html).toContain('Markets on AtPrice, sorted by liquidity, descending');
    expect(html).toContain('aria-sort="descending"');
    expect(text(html)).toContain('12.4K PUSDTEST · 27.41 BCH');
    expect(text(html)).toContain('12,402.55 PUSDTEST and 27.41 BCH');
    expect(html).toContain('href="/markets/bch-pusdtest"');
  });

  it('marks every market paused with the reason on a network mismatch', () => {
    const visible = text(render(createElement(MarketCards, { markets: [market()], networkMismatch: true })));
    expect(visible).toContain('Paused');
    expect(visible).toContain('Paused: Network mismatch');
  });

  it('prints missing data as Not available with the reason in its accessible name', () => {
    const visible = text(render(createElement(VolumeValue, { market: market() })));
    expect(visible).toBe('Not available 24 hour volume not available: Cauldron indexer does not report volume');
    expect(text(render(createElement(ChangeValue, { change: market().change24h })))).toContain('24h change not yet');
  });

  it('gives low liquidity its warning icon and word', () => {
    const html = render(
      createElement(AvailabilityBadge, { display: { availability: 'low_liquidity', label: 'Low liquidity', reason: null } }),
    );
    const warningGlyph = renderToStaticMarkup(createElement(WarningIcon, { weight: 'duotone' })).match(/ d="[^"]+"/g)?.at(-1);
    expect(warningGlyph).toBeDefined();
    expect(html).toContain(warningGlyph);
    expect(text(html)).toBe('Low liquidity');
  });
});
