import { binToHex, getDustThreshold, hexToBin, type Output } from '@bitauth/libauth';
import { TransactionBuilder, type Unlocker, type Utxo } from 'cashscript';
import {
  isCauldronV0Pool,
  poolLockingBytecode,
  poolUnlockingBytecode,
  type CauldronPoolUtxo,
} from '../cauldron.js';
import { BUY_PAYOUT_SATS, MIN_RELAY_FEE_PER_BYTE } from '../constants.js';
import { InvalidPoolError, OrderNotExecutableError, TransactionBuildError } from '../errors.js';
import type { Order } from '../order.js';
import { buyFill, sellFill, type PoolReserves } from '../quote.js';
import { utxoSourceOutput } from './utxo.js';
import { verifyTransaction } from './verify.js';

export interface BuyExecution {
  readonly side: 'buy';
  readonly bchIn: bigint;
  readonly tokensOut: bigint;
  readonly poolFee: bigint;
  /** Tokens delivered above `minOut`. */
  readonly surplus: bigint;
  readonly payoutSatoshis: bigint;
}

export interface SellExecution {
  readonly side: 'sell';
  readonly tokensIn: bigint;
  readonly bchOut: bigint;
  readonly poolFee: bigint;
  /** Satoshis paid above `minOut`. */
  readonly surplus: bigint;
  readonly payoutSatoshis: bigint;
}

export interface ExecuteTransaction {
  readonly hex: string;
  readonly txid: string;
  readonly size: number;
  /** Miner fee taken from the order's allowance. */
  readonly fee: bigint;
  readonly sourceOutputs: readonly Output[];
  readonly poolBefore: PoolReserves;
  readonly poolAfter: PoolReserves;
  readonly execution: BuyExecution | SellExecution;
}

/**
 * Miner fee policy: a rate in sat/B (default 1), or an exact amount. Whatever the order's
 * allowance leaves above the fee goes to the user.
 */
export type ExecuteFee =
  | { readonly kind: 'rate'; readonly satsPerByte: bigint }
  | { readonly kind: 'absolute'; readonly satoshis: bigint };

export interface ExecuteOptions {
  readonly fee?: ExecuteFee;
}

const MAX_FEE_ITERATIONS = 8;

const assertPool = (order: Order, pool: CauldronPoolUtxo): PoolReserves => {
  if (
    pool.lockingBytecode !== undefined &&
    !isCauldronV0Pool(hexToBin(pool.lockingBytecode), pool.ownerPkh)
  ) {
    throw new InvalidPoolError(
      'not_cauldron_v0',
      'pool locking bytecode is not the Cauldron V0 template for its owner hash',
    );
  }
  if (pool.token.category !== order.params.tokenCategory) {
    throw new InvalidPoolError(
      'token_mismatch',
      `pool holds ${pool.token.category}, order trades ${order.params.tokenCategory}`,
    );
  }
  if ('nft' in pool.token && pool.token.nft !== undefined) {
    throw new InvalidPoolError('nft_present', 'pool carries an NFT');
  }
  if (pool.satoshis <= 0n || pool.token.amount <= 0n) {
    throw new InvalidPoolError('empty_reserves', 'pool reserves must be positive');
  }
  return { sats: pool.satoshis, tokens: pool.token.amount };
};

const assertOrderUtxo = (order: Order, orderUtxo: Utxo): void => {
  const token = orderUtxo.token;
  if (order.params.side === 'buy' && token !== undefined) {
    throw new OrderNotExecutableError('order_token_mismatch', 'a buy order UTXO must not hold tokens');
  }
  if (order.params.side === 'sell') {
    if (token === undefined || token.category !== order.params.tokenCategory || token.amount <= 0n) {
      throw new OrderNotExecutableError(
        'order_token_mismatch',
        'the sell order UTXO does not hold the market token',
      );
    }
    if (token.nft !== undefined) {
      throw new OrderNotExecutableError('order_token_mismatch', 'the sell order UTXO carries an NFT');
    }
  }
};

interface Plan {
  readonly builder: TransactionBuilder;
  readonly poolAfter: PoolReserves;
  readonly execution: BuyExecution | SellExecution;
}

/**
 * Builds the 2-in-2-out fill `[pool, order] -> [pool continued, payout]` and verifies it in the
 * standard-policy VM before returning it, so a returned transaction is always relayable. The miner
 * fee is `size * rate` (default 1 sat/B) or an exact amount, never above `maxNetworkFee`; the rest
 * of the order's allowance goes into the pool on a buy (more tokens) and to the payout on a sell.
 */
export const buildExecuteTransaction = (
  order: Order,
  orderUtxo: Utxo,
  pool: CauldronPoolUtxo,
  options: ExecuteOptions = {},
): ExecuteTransaction => {
  const feePolicy = options.fee ?? { kind: 'rate', satsPerByte: MIN_RELAY_FEE_PER_BYTE };
  const poolBefore = assertPool(order, pool);
  assertOrderUtxo(order, orderUtxo);
  const { params, contract } = order;
  const poolLocking = poolLockingBytecode(pool.ownerPkh);
  const poolInput = { ...pool, lockingBytecode: binToHex(poolLocking) };
  const orderInput = { ...orderUtxo, lockingBytecode: orderUtxo.lockingBytecode ?? contract.lockingBytecode };
  const poolUnlocker: Unlocker = { generateUnlockingBytecode: () => poolUnlockingBytecode(pool.ownerPkh) };

  const plan = (fee: bigint): Plan => {
    const builder = new TransactionBuilder({ provider: contract.provider })
      .addInput(poolInput, poolUnlocker)
      .addInput(orderInput, contract.unlock.execute(pool.ownerPkh));
    if (params.side === 'buy') {
      const bchIn = orderUtxo.satoshis - BUY_PAYOUT_SATS - fee;
      if (bchIn <= 0n)
        throw new OrderNotExecutableError(
          'order_value_too_small',
          'order value does not cover payout and fee',
        );
      const fill = buyFill(poolBefore, bchIn);
      if (fill.tokensOut < params.minOut) {
        throw new OrderNotExecutableError(
          'below_min_out',
          `pool releases ${fill.tokensOut} tokens, minOut is ${params.minOut}`,
        );
      }
      builder
        .addOutput({
          to: poolLocking,
          amount: fill.poolAfter.sats,
          token: { category: params.tokenCategory, amount: fill.poolAfter.tokens },
        })
        .addOutput({
          to: params.recipientLockingBytecode,
          amount: BUY_PAYOUT_SATS,
          token: { category: params.tokenCategory, amount: fill.tokensOut },
        });
      return {
        builder,
        poolAfter: fill.poolAfter,
        execution: {
          side: 'buy',
          bchIn,
          tokensOut: fill.tokensOut,
          poolFee: fill.poolFee,
          surplus: fill.tokensOut - params.minOut,
          payoutSatoshis: BUY_PAYOUT_SATS,
        },
      };
    }
    const tokensIn = orderUtxo.token?.amount ?? 0n;
    const fill = sellFill(poolBefore, tokensIn);
    const payout = fill.bchOut + orderUtxo.satoshis - fee;
    if (payout < params.minOut) {
      throw new OrderNotExecutableError(
        'below_min_out',
        `payout ${payout} sats is below minOut ${params.minOut}`,
      );
    }
    const poolOutput: Output = {
      lockingBytecode: poolLocking,
      valueSatoshis: fill.poolAfter.sats,
      token: { category: hexToBin(params.tokenCategory), amount: fill.poolAfter.tokens },
    };
    if (fill.poolAfter.sats < getDustThreshold(poolOutput)) {
      throw new OrderNotExecutableError('pool_below_dust', 'the fill would leave the pool output below dust');
    }
    builder
      .addOutput({
        to: poolLocking,
        amount: fill.poolAfter.sats,
        token: { category: params.tokenCategory, amount: fill.poolAfter.tokens },
      })
      .addOutput({ to: params.recipientLockingBytecode, amount: payout });
    return {
      builder,
      poolAfter: fill.poolAfter,
      execution: {
        side: 'sell',
        tokensIn,
        bchOut: fill.bchOut,
        poolFee: fill.poolFee,
        surplus: payout - params.minOut,
        payoutSatoshis: payout,
      },
    };
  };

  const finish = (current: Plan, fee: bigint): ExecuteTransaction => {
    const sourceOutputs = [utxoSourceOutput(poolInput), utxoSourceOutput(orderInput)];
    const verified = verifyTransaction(current.builder.build(), sourceOutputs);
    return {
      hex: verified.hex,
      txid: verified.txid,
      size: verified.size,
      fee,
      sourceOutputs,
      poolBefore,
      poolAfter: current.poolAfter,
      execution: current.execution,
    };
  };
  const assertWithinCap = (fee: bigint): void => {
    if (fee > params.maxNetworkFee) {
      throw new OrderNotExecutableError(
        'fee_above_cap',
        `fee ${fee} exceeds maxNetworkFee ${params.maxNetworkFee}`,
      );
    }
  };

  if (feePolicy.kind === 'absolute') {
    assertWithinCap(feePolicy.satoshis);
    return finish(plan(feePolicy.satoshis), feePolicy.satoshis);
  }
  // Amount encodings only shrink as the fee grows, so the fee only ever has to rise to meet the size.
  let fee = 0n;
  for (let iteration = 0; iteration < MAX_FEE_ITERATIONS; iteration += 1) {
    const current = plan(fee);
    const required = current.builder.getTransactionSize() * feePolicy.satsPerByte;
    assertWithinCap(required);
    if (fee >= required) return finish(current, fee);
    fee = required;
  }
  throw new TransactionBuildError(
    'fee_did_not_converge',
    `fee did not settle after ${MAX_FEE_ITERATIONS} rounds`,
  );
};
