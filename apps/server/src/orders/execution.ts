import { binToHex } from '@bitauth/libauth';
import type { OrderParams } from '@atprice/core';
import type { InstanceObservation, OrderObserver } from './observe.js';
import { outpointId } from './model.js';
import type { ExecutionRecord } from './record.js';

/**
 * Builds the `executions` row for an observed execute spend from the transaction itself and the pool
 * input's previous output, so third-party fills are recorded exactly like the keeper's own.
 */
export const deriveExecution = async (
  observer: OrderObserver,
  observation: InstanceObservation,
): Promise<ExecutionRecord | undefined> => {
  const spend = observation.spend;
  if (spend === undefined || spend.classification.path !== 'execute') return undefined;
  const { classification, transaction } = spend;
  const poolInput = transaction.inputs[0];
  if (poolInput === undefined) return undefined;
  const poolTxid = binToHex(poolInput.outpointTransactionHash);
  const poolPrevious = (await observer.transaction(poolTxid)).outputs[poolInput.outpointIndex];
  if (poolPrevious?.token === undefined) return undefined;
  const params: OrderParams = observation.instance.params;
  const poolBefore = { sats: poolPrevious.valueSatoshis, tokens: poolPrevious.token.amount };
  const order = observation.instance;
  const isBuy = params.side === 'buy';
  const inputAmount = isBuy ? classification.poolAfter.sats - poolBefore.sats : (order.token?.amount ?? 0n);
  const bchOut = poolBefore.sats - classification.poolAfter.sats;
  const networkFee = isBuy
    ? order.satoshis + poolBefore.sats - classification.poolAfter.sats - classification.payoutSatoshis
    : bchOut + order.satoshis - classification.payoutSatoshis;
  return {
    txid: spend.txid,
    side: params.side,
    inputAmount,
    outputAmount: classification.delivered,
    surplus: classification.delivered - params.minOut,
    networkFee,
    payoutSatoshis: classification.payoutSatoshis,
    routeMetadata: {
      poolOwnerPkh: classification.poolOwnerPkh,
      poolOutpoint: outpointId(poolTxid, poolInput.outpointIndex),
      poolSatsBefore: poolBefore.sats.toString(),
      poolTokensBefore: poolBefore.tokens.toString(),
      poolSatsAfter: classification.poolAfter.sats.toString(),
      poolTokensAfter: classification.poolAfter.tokens.toString(),
    },
  };
};
