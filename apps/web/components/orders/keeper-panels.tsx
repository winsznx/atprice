'use client';

import { useQuery } from '@tanstack/react-query';
import { CaretDownIcon } from '@phosphor-icons/react';
import { Num } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import { ErrorState, InlineAlert } from '@/components/states';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { CONTROL_TRANSITION } from '@/components/ui/button';
import { isApiError } from '@/lib/api/errors';
import { queries } from '@/lib/api/queries';
import type { Health, Order, Outpoint, Ratio } from '@/lib/api/schemas';
import { useNow } from '@/lib/hooks/use-now';
import { receivedText } from '@/lib/orders/display';
import { cn } from '@/lib/utils';
import { conditionText, executionCondition, keeperStale, outcomeWords } from './order-detail';

/** `Execution condition` with the keeper staleness warning (order-detail.md "Open"). */
export function ExecutionCondition({
  order,
  spot,
  health,
}: {
  order: Order;
  spot: Ratio | null;
  health: Health | undefined;
}) {
  const now = useNow();
  const condition = executionCondition(order, spot);
  const stale = now !== null && keeperStale(order.keeperCheck, health, now);
  return (
    <section aria-labelledby="condition-title" className="flex flex-col gap-3 rounded-lg border border-border p-5 lg:p-6">
      <h2 id="condition-title" className="font-display text-heading-3 text-fg">
        Execution condition
      </h2>
      <p className="num max-w-[64ch] text-body text-fg-secondary">{conditionText(condition)}</p>
      {order.keeperCheck === null ? null : (
        <p className="text-caption text-fg-muted">
          AtPrice’s keeper, last check <LocalTime iso={order.keeperCheck.checkedAt} />
        </p>
      )}
      {stale && order.keeperCheck !== null ? (
        <InlineAlert tone="warning">
          <p>
            AtPrice’s keeper hasn’t checked this order since <LocalTime iso={order.keeperCheck.checkedAt} withDate />.
            Another filler can still fill it, and you can still cancel.
          </p>
        </InlineAlert>
      ) : null}
    </section>
  );
}

const MAX_ROWS = 20;

interface CheckRow {
  readonly key: string;
  readonly at: string;
  readonly outcome: string;
  readonly detail: string | null;
  readonly bestOutput: bigint | null;
  readonly pool: Outpoint | null;
}

function Outcome({ code, detail }: { code: string; detail: string | null }) {
  const words = outcomeWords(code);
  return (
    <span className="flex flex-col">
      {words.known ? words.text : <span className="hash text-mono-sm">{words.text}</span>}
      {detail === null ? null : <span className="text-caption text-fg-muted">{detail}</span>}
    </span>
  );
}

/** `Keeper checks` (collapsible, last 20): the latest evaluation, then the keeper's attempts. */
export function KeeperChecks({ order }: { order: Order }) {
  const executions = useQuery({ ...queries.orderExecutions(order.id), refetchInterval: 15_000 });
  const rows: CheckRow[] = [];
  if (order.keeperCheck !== null) {
    rows.push({
      key: 'latest',
      at: order.keeperCheck.checkedAt,
      outcome: order.keeperCheck.outcome,
      detail: null,
      bestOutput: order.keeperCheck.bestOutput,
      pool: order.keeperCheck.poolOutpoint,
    });
  }
  for (const attempt of executions.data?.attempts ?? []) {
    rows.push({
      key: attempt.id,
      at: attempt.createdAt,
      outcome: attempt.outcome,
      detail: attempt.reason,
      bestOutput: null,
      pool: attempt.poolOutpoint,
    });
  }
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <Collapsible className="rounded-lg border border-border">
      <CollapsibleTrigger
        className={cn(
          'group flex min-h-(--size-control) w-full items-center justify-between gap-3 rounded-lg px-5 py-3 text-left lg:px-6',
          'hover:bg-surface-sunken',
          CONTROL_TRANSITION,
        )}
      >
        <span className="font-display text-heading-3 text-fg">Keeper checks</span>
        <CaretDownIcon
          aria-hidden="true"
          className="size-5 text-fg-muted motion-safe:transition-transform motion-safe:duration-(--duration-base) ease-move group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-5 pb-5 lg:px-6 lg:pb-6">
          {executions.isError ? (
            <ErrorState
              what="AtPrice can’t load the keeper’s attempts for this order right now."
              code={isApiError(executions.error) ? executions.error.displayCode : 'API_ERROR'}
              onRetry={() => void executions.refetch()}
              retrying={executions.isFetching}
              className="mb-3"
            />
          ) : null}
          {executions.isPending && rows.length === 0 ? (
            <div aria-busy="true" className="flex flex-col gap-2">
              <p role="status" className="sr-only">
                Loading keeper checks
              </p>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : shown.length === 0 ? (
            <p className="text-body-sm text-fg-muted">
              No keeper checks yet. AtPrice’s keeper checks open orders after their funding confirms.
            </p>
          ) : (
            <ul className="flex flex-col">
              <li aria-hidden="true" className="hidden grid-cols-[6rem_1fr_1fr_14rem] gap-3 border-b border-border pb-2 text-eyebrow text-fg-muted uppercase lg:grid">
                <span>Time</span>
                <span>Outcome</span>
                <span>Best quote for the whole order</span>
                <span>Pool</span>
              </li>
              {shown.map((row) => (
                <li
                  key={row.key}
                  className="grid grid-cols-1 gap-1 border-b border-border py-3 text-body-sm last:border-0 lg:grid-cols-[6rem_1fr_1fr_14rem] lg:items-start lg:gap-3"
                >
                  <span className="text-fg-muted">
                    <span className="sr-only">Time </span>
                    <LocalTime iso={row.at} />
                  </span>
                  <span>
                    <span className="sr-only">Outcome </span>
                    <Outcome code={row.outcome} detail={row.detail} />
                  </span>
                  <span>
                    <span className="sr-only">Best quote for the whole order </span>
                    {row.bestOutput === null ? (
                      <span className="text-fg-muted">Not available</span>
                    ) : (
                      <Num>{receivedText(order, row.bestOutput, 'compact')}</Num>
                    )}
                  </span>
                  <span className="min-w-0">
                    {row.pool === null ? (
                      <span className="text-fg-muted">No pool</span>
                    ) : (
                      <HashChip
                        value={`${row.pool.txid}:${row.pool.vout}`}
                        kind="outpoint"
                        label={`Pool ${row.pool.txid}:${row.pool.vout}`}
                      />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
