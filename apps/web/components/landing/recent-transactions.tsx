'use client';

import { HashChip } from '@/components/hash-chip';
import { StatusBadge } from '@/components/status-badge';
import { PairLogos } from '@/components/token-logo';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { EvidenceOrder } from '@/lib/api/schemas';
import { formatBlockHeight } from '@/lib/format';
import { appNetwork } from '@/lib/network';
import { bchText, orderInputText, pairLabel, receivedText, tokenSymbol } from '@/lib/orders/display';

/** `0.05 BCH → 22.61 PUSD` in DD 4 `compact` mode; a cancel reads as what came back. */
export const paidReceived = (order: EvidenceOrder): { paid: string; received: string } => {
  const paid = orderInputText(order, 'compact');
  const settlement = order.settlement;
  if (settlement.kind === 'fill')
    return { paid, received: receivedText(order, settlement.received, 'compact') };
  const refund =
    order.side === 'sell' && settlement.refundTokens > 0n
      ? `${orderInputText({ ...order, amount: settlement.refundTokens }, 'compact')} + ${bchText(settlement.refundSats, 'compact')}`
      : bchText(settlement.refundSats, 'compact');
  return { paid, received: `${refund} refunded` };
};

function Flow({ order }: { order: EvidenceOrder }) {
  const { paid, received } = paidReceived(order);
  return (
    <span className="num">
      {paid}
      <span aria-hidden="true"> → </span>
      <span className="sr-only"> to </span>
      {received}
    </span>
  );
}

const resultOf = (order: EvidenceOrder) => (order.settlement.kind === 'fill' ? 'FILLED' : 'CANCELLED');

export function RecentTransactionsTable({ orders }: { orders: readonly EvidenceOrder[] }) {
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableCaption>{`Recent completed AtPrice orders on ${appNetwork.name}`}</TableCaption>
          <colgroup>
            <col className="w-[16%]" />
            <col className="w-[14%]" />
            <col className="w-[34%]" />
            <col className="w-[14%]" />
            <col className="w-[22%]" />
          </colgroup>
          <TableHeader>
            <tr>
              <TableHead>Result</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Paid → received</TableHead>
              <TableHead className="text-right">Settled in block</TableHead>
              <TableHead>Transaction</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell>
                  <StatusBadge status={resultOf(order)} />
                </TableCell>
                <TableCell className="text-num-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <PairLogos
                      tokenCategory={order.tokenCategory}
                      symbol={tokenSymbol(order.tokenCategory)}
                    />
                    {pairLabel(order.tokenCategory)}
                  </span>
                </TableCell>
                <TableCell className="text-num-sm">
                  <Flow order={order} />
                </TableCell>
                <TableCell className="text-right text-num-sm">
                  <span className="num">{formatBlockHeight(order.settlementBlock.height)}</span>
                </TableCell>
                <TableCell>
                  <HashChip value={order.settlement.txid} kind="tx" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul
        className="flex flex-col gap-3 md:hidden"
        aria-label={`Recent completed AtPrice orders on ${appNetwork.name}`}
      >
        {orders.map((order) => (
          <li
            key={order.id}
            className="flex flex-col gap-2 rounded-lg border border-border p-(--space-panel)"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge status={resultOf(order)} />
              <span className="text-body-sm text-fg-secondary">
                block <span className="num text-fg">{formatBlockHeight(order.settlementBlock.height)}</span>
              </span>
            </div>
            <p className="text-num-sm text-fg">
              <PairLogos
                tokenCategory={order.tokenCategory}
                symbol={tokenSymbol(order.tokenCategory)}
                className="mr-1.5 align-middle"
              />
              {pairLabel(order.tokenCategory)}
              <span aria-hidden="true">: </span>
              <span className="sr-only">, </span>
              <Flow order={order} />
            </p>
            <HashChip value={order.settlement.txid} kind="tx" />
          </li>
        ))}
      </ul>
    </>
  );
}
