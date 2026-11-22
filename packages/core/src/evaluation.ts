import { BUY_PAYOUT_SATS, MEASURED_EXECUTE_SIZES } from './constants.js';
import type { OrderSide } from './order.js';

/**
 * The fixed execute size the keeper fee and the health evaluator's pinned supply are computed from
 * (architecture.md, health: "one constant in packages/core, used by both paths"). It is the largest
 * measured 2-in-2-out execute (buy, P2SH32 recipient), so a fee at this size always covers the real
 * transaction at the same rate.
 */
export const EXECUTE_FEE_SIZE_BYTES = BigInt(
  Math.max(
    MEASURED_EXECUTE_SIZES.buyP2pkh,
    MEASURED_EXECUTE_SIZES.buyP2sh32,
    MEASURED_EXECUTE_SIZES.sellP2pkh,
    MEASURED_EXECUTE_SIZES.sellP2sh32,
  ),
);

/**
 * The execute miner fee at `satsPerByte`, clamped to the order's `maxNetworkFee` so a fee-rate change
 * can never turn every order into a fill the contract rejects (contract.md step 8).
 */
export const executeFee = (satsPerByte: bigint, maxNetworkFee: bigint): bigint => {
  const fee = EXECUTE_FEE_SIZE_BYTES * satsPerByte;
  return fee < maxNetworkFee ? fee : maxNetworkFee;
};

/** The order UTXO an evaluation is for. */
export interface EvaluatedOrderUtxo {
  readonly side: OrderSide;
  readonly satoshis: bigint;
  /** Token units held (sell orders); 0 for a buy. */
  readonly tokenAmount: bigint;
}

/**
 * The supply fed into the pool, pinned so the keeper and the evaluator compare like with like:
 * buy `V - 1000 - f` satoshis, sell the order's token amount. Zero or less means the order cannot pay
 * its payout and fee.
 */
export const pinnedSupply = (order: EvaluatedOrderUtxo, fee: bigint): bigint =>
  order.side === 'buy' ? order.satoshis - BUY_PAYOUT_SATS - fee : order.tokenAmount;

/**
 * What the recipient receives for a pool output (`demand`): buy, the token units released; sell,
 * the BCH released plus the order's own 2000 sats minus the fee.
 */
export const recipientAmount = (order: EvaluatedOrderUtxo, demand: bigint, fee: bigint): bigint =>
  order.side === 'buy' ? demand : demand + order.satoshis - fee;
