import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CancelAction } from './order-actions';
import type { CancelAvailability, Ownership } from './order-detail';
import { OrderTerms } from './order-terms';
import { makeOrder, makeSellOrder } from './test-fixtures';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('OrderTerms privacy (order-detail.md, FR-014)', () => {
  it('shows the recipient address only to the connected owner', () => {
    // #given
    const order = makeOrder();
    // #when
    const publicView = renderToStaticMarkup(createElement(OrderTerms, { order, isOwner: false }));
    const ownerView = renderToStaticMarkup(createElement(OrderTerms, { order, isOwner: true }));
    // #then
    expect([publicView.includes('Paid to'), ownerView.includes('Paid to')]).toEqual([false, true]);
  });

  it('lists the buy lock as order, fee cap and dust in exact mode', () => {
    const html = text(
      renderToStaticMarkup(createElement(OrderTerms, { order: makeOrder(), isOwner: false })),
    );
    expect(html).toContain(
      '0.50003000 BCH 0.50000000 BCH order + 0.00002000 BCH fee cap + 0.00001000 BCH dust',
    );
  });

  it('shows a sell minimum as proceeds with the payout line, never the raw minOut', () => {
    const html = text(
      renderToStaticMarkup(createElement(OrderTerms, { order: makeSellOrder(), isOwner: false })),
    );
    expect([html.includes('at least 0.05200000 BCH'), html.includes('0.05202000 BCH :')]).toEqual([
      true,
      true,
    ]);
  });
});

const renderAction = (ownership: Ownership, availability: CancelAvailability): string =>
  text(
    renderToStaticMarkup(
      createElement(CancelAction, {
        ownership,
        availability,
        recoverHref: '/recover?txid=x',
        networkMismatch: false,
        cancelRef: createRef<HTMLButtonElement>(),
        messageRef: createRef<HTMLParagraphElement>(),
        onCancel: () => undefined,
      }),
    ),
  );

describe('CancelAction states', () => {
  it('asks a disconnected viewer to connect the wallet that created the order', () => {
    expect(renderAction({ kind: 'disconnected' }, { kind: 'hidden' })).toContain(
      'Connect the wallet that created this order to cancel it. Connect wallet',
    );
  });

  it('renders no cancel button for a different wallet, only the reason', () => {
    const html = renderAction({ kind: 'not_owner' }, { kind: 'hidden' });
    expect([
      html.includes('Cancel order'),
      html.includes('This order belongs to a different wallet.'),
    ]).toEqual([false, true]);
  });

  it('keeps a disabled cancel reachable with its reason', () => {
    const html = renderToStaticMarkup(
      createElement(CancelAction, {
        ownership: { kind: 'owner', reconnectingSince: null },
        availability: {
          kind: 'disabled',
          reason: 'A cancel is already waiting for confirmation.',
          reconnecting: false,
        },
        recoverHref: '/recover?txid=x',
        networkMismatch: false,
        cancelRef: createRef<HTMLButtonElement>(),
        messageRef: createRef<HTMLParagraphElement>(),
        onCancel: () => undefined,
      }),
    );
    expect([
      html.includes('aria-disabled="true"'),
      html.includes('A cancel is already waiting for confirmation.'),
    ]).toEqual([true, true]);
  });
});
