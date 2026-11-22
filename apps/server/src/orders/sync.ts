import { binToHex } from '@bitauth/libauth';
import { orderLockingBytecode, type OrderParams } from '@atprice/core';
import { transitionEvents, type Analytics } from '../analytics.js';
import type { Db } from '../db/pool.js';
import { deriveExecution } from './execution.js';
import { paramsFromRow, type OrderRow } from './model.js';
import type { OrderObserver } from './observe.js';
import { recordObservation, type ObservationOutcome } from './record.js';

export interface SyncResult {
  readonly orderId: string;
  readonly outcome: ObservationOutcome;
  readonly supported: boolean | undefined;
}

export interface SyncOptions {
  /** True for fallback-sweep observations (vanish counting). */
  readonly sweep: boolean;
  readonly reason: string;
  readonly analytics: Analytics;
}

/**
 * Full resync of one order address: every instance the history shows, plus every stored instance the
 * history no longer shows (vanished funding). Repeating it is harmless: same-state observations are
 * no-ops on status.
 */
export const syncOrderAddress = async (
  db: Db,
  observer: OrderObserver,
  params: OrderParams,
  options: SyncOptions,
): Promise<SyncResult[]> => {
  const lockingHex = binToHex(orderLockingBytecode(params));
  const { rows: known } = await db.query<{ id: string; instance_kind: string }>(
    'SELECT id, instance_kind FROM orders WHERE network = $1 AND order_locking_bytecode = $2',
    [observer.network, lockingHex],
  );
  const parentId = known.find((row) => row.instance_kind === 'funding')?.id;
  const observation = await observer.observeAddress(params, {
    expected: known.map((row) => row.id),
    ...(parentId !== undefined && { parentId }),
  });
  const results: SyncResult[] = [];
  // Funding instances first, so a stray's parent exists before the stray row.
  const ordered = [...observation.instances].sort(
    (a, b) => Number(a.instance.instanceKind === 'stray') - Number(b.instance.instanceKind === 'stray'),
  );
  for (const instance of ordered) {
    const execution = await deriveExecution(observer, instance);
    const outcome = await recordObservation(db, {
      orderId: instance.instance.id,
      network: observer.network,
      instance: instance.instance,
      facts: instance.facts,
      funding: instance.funding,
      spend:
        instance.spend === undefined
          ? undefined
          : {
              txid: instance.spend.txid,
              height: instance.spend.height,
              blockHash: instance.spend.blockHash,
              kind: instance.spend.classification.path,
            },
      sweep: options.sweep,
      observerTipHeight: observation.tipHeight,
      ...(execution !== undefined && { execution }),
      detail: {
        reason: options.reason,
        ...(instance.spend?.classification.path === 'unknown' && {
          unknownSpend: instance.spend.classification.reason,
        }),
      },
    });
    if (outcome.decision.kind === 'transition') {
      for (const event of transitionEvents(outcome.decision.from, outcome.decision.to)) {
        options.analytics.emit(event, {
          orderId: instance.instance.id,
          side: instance.instance.params.side,
          tokenId: instance.instance.params.tokenCategory,
          supported: instance.instance.support.supported,
          txid: instance.spend?.txid ?? instance.instance.txid,
          via: options.reason,
        });
      }
    }
    results.push({ orderId: instance.instance.id, outcome, supported: instance.instance.support.supported });
  }
  for (const orderId of observation.missing) {
    const outcome = await recordObservation(db, {
      orderId,
      network: observer.network,
      facts: { funding: 'missing', spend: { kind: 'none' } },
      funding: undefined,
      spend: undefined,
      sweep: options.sweep,
      observerTipHeight: observation.tipHeight,
      detail: { reason: options.reason },
    });
    results.push({ orderId, outcome, supported: undefined });
  }
  return results;
};

export const syncStoredOrder = async (
  db: Db,
  observer: OrderObserver,
  row: OrderRow,
  options: SyncOptions,
): Promise<SyncResult[]> => syncOrderAddress(db, observer, paramsFromRow(row), options);
