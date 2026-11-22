import { SELL_ORDER_SATS, type Network } from '@atprice/core';
import { binToHex } from '@bitauth/libauth';
import type { ReactNode, RefObject } from 'react';
import { formatBlockHeight } from '../../../web/lib/format';
import {
  aboveMinimumText,
  bchText,
  contractAddressOf,
  feeText,
  heldLines,
  minimumLine,
  parameterRows,
  recipientAddressOf,
  sideLabel,
  spokenGroups,
  STATUS_BADGE,
  tokenLabel,
  tokenText,
} from '../core/describe';
import { confirmationsAt, type LoadedOrder, type OrderChainStatus } from '../core/lookup';
import { addressExplorer, txExplorer } from './explorer';
import { Badge, cx, HashChip, outpointDisplay, Row, type Tone } from './primitives';
import { SectionHeading } from './section';

const STATUS_TONE: Readonly<Record<OrderChainStatus['kind'], Tone>> = {
  unspent: 'open',
  filled: 'filled',
  cancelled: 'cancelled',
  needs_review: 'review',
};

export const isUnconfirmedFunding = (order: LoadedOrder): boolean =>
  order.status.kind === 'unspent' && order.fundingHeight <= 0;

export function OrderBadge({ order }: { order: LoadedOrder }) {
  if (isUnconfirmedFunding(order)) return <Badge tone="pending">Funding not confirmed yet</Badge>;
  return <Badge tone={STATUS_TONE[order.status.kind]}>{STATUS_BADGE[order.status.kind]}</Badge>;
}

const confirmationsText = (height: number, tip: number): string =>
  height > 0
    ? `${confirmationsAt(height, tip).toLocaleString('en-US')} confirmation${confirmationsAt(height, tip) === 1 ? '' : 's'}, block ${formatBlockHeight(height)}`
    : 'Not yet confirmed';

/** The order key hash, readable in groups of four by a screen reader. */
function OwnerChip({ order }: { order: LoadedOrder }) {
  const hex = binToHex(order.record.ownerPkh);
  return <HashChip value={hex} kind="keyhash" label={`Owner key hash ${spokenGroups(hex)}`} />;
}

/** One order in an address search's results. */
function OrderCard({
  order,
  selected,
  onSelect,
}: {
  order: LoadedOrder;
  selected: boolean;
  onSelect: () => void;
}) {
  const amount =
    order.record.side === 'buy'
      ? bchText(order.fundingOutput.satoshis)
      : tokenText(order, order.fundingOutput.token?.amount ?? 0n);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cx(
          'flex w-full flex-col gap-2 rounded-md border p-4 text-left hover:bg-surface-sunken',
          selected ? 'border-brand bg-surface-selected' : 'border-border bg-surface',
        )}
      >
        <span className="flex flex-wrap items-center gap-2 text-label text-fg">
          {sideLabel(order)} {tokenLabel(order)} <OrderBadge order={order} />
        </span>
        <span className="num text-num-md text-fg">{amount}</span>
        <span className="hash text-mono-sm text-fg-muted">
          {outpointDisplay(order.funding.txid, order.funding.vout)}
        </span>
      </button>
    </li>
  );
}

export type OrderResults =
  | {
      readonly kind: 'orders';
      readonly orders: readonly LoadedOrder[];
      readonly unknownVersions: readonly number[];
    }
  | { readonly kind: 'no_record' }
  | { readonly kind: 'no_orders' }
  | { readonly kind: 'unknown_version'; readonly version: number; readonly txid: string };

/** Step 3 of 4: the order as rebuilt from its funding transaction, with nothing taken on trust. */
export function OrderSection({
  results,
  selected,
  onSelect,
  tip,
  network,
  headingRef,
}: {
  network: Network;
  results: OrderResults;
  selected: LoadedOrder | null;
  onSelect: (order: LoadedOrder) => void;
  tip: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  let body: ReactNode;
  if (results.kind === 'no_record') {
    body = (
      <p className="text-body text-fg-secondary">
        This transaction has no AtPrice order record. Check you copied the funding transaction, the one that
        sent funds to the order.
      </p>
    );
  } else if (results.kind === 'no_orders') {
    body = <NoOrders network={network} />;
  } else if (results.kind === 'unknown_version') {
    body = (
      <div className="flex flex-col gap-2">
        <Badge tone="review">Contract version {results.version}</Badge>
        <p className="text-body text-fg-secondary">
          This order uses contract version <span className="num">{results.version}</span>, which this file
          doesn't include. Use a newer AtPrice Recover file or pnpm recover from a newer source.
        </p>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {results.orders.length > 1 ? (
          <ul aria-label="Orders owned by this address" className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {results.orders.map((order) => (
              <OrderCard
                key={`${order.funding.txid}:${order.funding.vout}`}
                order={order}
                selected={selected === order}
                onSelect={() => onSelect(order)}
              />
            ))}
          </ul>
        ) : null}
        {results.unknownVersions.length > 0 ? (
          <p className="text-body-sm text-fg-secondary">
            This address also has AtPrice records of contract version {results.unknownVersions.join(', ')},
            which this file doesn't include. Use a newer AtPrice Recover file to read them.
          </p>
        ) : null}
        {selected === null ? (
          <p className="text-body-sm text-fg-muted">Choose an order to see its details and cancel it.</p>
        ) : (
          <OrderDetail order={selected} tip={tip} />
        )}
      </div>
    );
  }
  return (
    <section aria-labelledby="step-order" className="flex flex-col gap-4">
      <SectionHeading id="step-order" step={3} title="Order" headingRef={headingRef} />
      {body}
    </section>
  );
}

function NoOrders({ network }: { network: Network }) {
  return (
    <p className="text-body text-fg-secondary">
      No AtPrice orders are owned by this address on {network}. AtPrice orders are owned by the first receive
      address of the wallet that funded them. If you have the funding transaction id, search by that instead.
    </p>
  );
}

export function OrderDetail({ order, tip }: { order: LoadedOrder; tip: number }) {
  const minimum = minimumLine(order);
  const contractAddress = contractAddressOf(order);
  const recipient = recipientAddressOf(order);
  const outpoint = `${order.funding.txid}:${order.funding.vout}`;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2 text-label text-fg">
        <span>
          {sideLabel(order)} {tokenLabel(order)} · contract v
          <span className="num">{order.record.version}</span>
        </span>
        <OrderBadge order={order} />
      </p>
      {order.market === undefined ? (
        <p className="text-body-sm text-fg-secondary">
          This token is not on the list this file ships, so it is shown by its category id only. The order can
          still be cancelled.
        </p>
      ) : null}
      <dl className="flex flex-col divide-y divide-border">
        <Row label="Locked">
          {heldLines(order, order.fundingOutput).map((line) => (
            <span key={line} className="num">
              {line}
            </span>
          ))}
        </Row>
        <Row label="Receives at least">
          <span className={minimum.kind === 'none' ? 'text-body-sm text-fg-secondary' : 'num'}>
            {minimum.text}
          </span>
          {minimum.kind === 'sell' ? (
            <span className="text-body-sm text-fg-secondary">{minimum.payoutLine}</span>
          ) : null}
        </Row>
        <Row label="Fee cap">
          <span className="num">{feeText(order.record.maxNetworkFee)}</span>
        </Row>
        <Row label="Owner">
          <span className="text-body-sm text-fg-secondary">Key hash</span>
          <OwnerChip order={order} />
        </Row>
        <Row label="Paid to">
          <HashChip value={recipient} kind="address" explorer={addressExplorer(order.network, recipient)} />
        </Row>
        {order.market === undefined ? (
          <Row label="Token">
            <HashChip value={order.record.tokenCategory} kind="token" />
          </Row>
        ) : null}
        <Row label="Contract">
          <HashChip
            value={contractAddress}
            kind="address"
            explorer={addressExplorer(order.network, contractAddress)}
          />
        </Row>
        <Row label="Funding">
          <HashChip
            value={outpoint}
            kind="outpoint"
            display={outpointDisplay(order.funding.txid, order.funding.vout)}
            explorer={txExplorer(order.network, order.funding.txid)}
          />
          <span className="text-body-sm text-fg-secondary">
            {confirmationsText(order.fundingHeight, tip)}
          </span>
        </Row>
        <Row label="Parameters">
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer items-center text-body text-link underline underline-offset-4">
              <span className="text-fg-secondary no-underline">
                ATPR v{order.record.version}, decoded locally.
              </span>
              &nbsp;Show
            </summary>
            <dl className="mt-2 flex flex-col gap-3 rounded-md bg-surface-sunken p-4">
              {parameterRows(order).map((row) => (
                <div key={row.label} className="flex flex-col gap-1">
                  <dt className="text-caption text-fg-muted">{row.label}</dt>
                  <dd className={row.mono ? 'hash text-mono-md text-fg' : 'num text-body-sm text-fg'}>
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </Row>
      </dl>
      <OrderOutcome order={order} tip={tip} />
    </div>
  );
}

/** What replaces step 4 when the order is already spent (recover.md "States"). */
export function OrderOutcome({ order, tip }: { order: LoadedOrder; tip: number }) {
  const status = order.status;
  if (status.kind === 'unspent') {
    return isUnconfirmedFunding(order) ? (
      <p className="text-body-sm text-fg-secondary">
        Your cancel confirms in the same block as the funding or after it.
      </p>
    ) : null;
  }
  if (status.kind === 'needs_review') {
    return (
      <div className="flex flex-col gap-2 rounded-md bg-status-review-subtle p-4">
        <p className="text-body-sm text-fg">
          The order output was spent by a transaction that is neither a fill nor a cancel ({status.reason}).
        </p>
        <HashChip value={status.txid} kind="tx" explorer={txExplorer(order.network, status.txid)} />
      </div>
    );
  }
  if (status.kind === 'filled') {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-label text-fg">Filled</h3>
        <dl className="flex flex-col divide-y divide-border">
          <Row label="You received">
            <span className="num text-num-lg">
              {order.record.side === 'buy'
                ? tokenText(order, status.spend.delivered)
                : bchText(status.spend.payoutSatoshis)}
            </span>
            {order.record.side === 'sell' ? (
              <span className="text-body-sm text-fg-secondary">
                {bchText(status.spend.payoutSatoshis - SELL_ORDER_SATS)} for your tokens + 2,000 sat reserve
                returned
              </span>
            ) : null}
          </Row>
          <Row label="Above your minimum">
            <span className="num">{aboveMinimumText(order, status.spend.delivered)}</span>
          </Row>
          <Row label="Pool used">
            <HashChip
              value={`${status.pool.txid}:${status.pool.vout}`}
              kind="outpoint"
              display={outpointDisplay(status.pool.txid, status.pool.vout)}
              explorer={txExplorer(order.network, status.pool.txid)}
            />
          </Row>
          <Row label="Pool owner">
            <HashChip value={status.spend.poolOwnerPkh} kind="keyhash" />
          </Row>
          <Row label="Filled by">
            <span>Not identifiable from the chain</span>
          </Row>
          <Row label="Settlement">
            <HashChip value={status.txid} kind="tx" explorer={txExplorer(order.network, status.txid)} />
          </Row>
          <Row label="Confirmations">
            <span className="num">{confirmationsText(status.height, tip)}</span>
          </Row>
        </dl>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label text-fg">Cancelled</h3>
      <dl className="flex flex-col divide-y divide-border">
        <Row label="Refunded">
          {heldLines(order, status.refund).map((line) => (
            <span key={line} className="num">
              {line}
            </span>
          ))}
        </Row>
        <Row label="Authorized by">
          <span>
            {status.authorization === 'cancel'
              ? 'A coin at the owner address (cancel)'
              : "The owner wallet's signature inside the contract (cancelWithSig)"}
          </span>
        </Row>
        <Row label="Cancel transaction">
          <HashChip value={status.txid} kind="tx" explorer={txExplorer(order.network, status.txid)} />
        </Row>
        <Row label="Confirmations">
          <span className="num">{confirmationsText(status.height, tip)}</span>
        </Row>
      </dl>
    </div>
  );
}
