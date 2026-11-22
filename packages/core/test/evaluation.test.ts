import { describe, expect, it } from 'vitest';
import {
  buildExecuteTransaction,
  buyFill,
  EXECUTE_FEE_SIZE_BYTES,
  executeFee,
  instantiateOrder,
  MAX_NETWORK_FEE_FLOOR,
  MEASURED_EXECUTE_SIZES,
  pinnedSupply,
  recipientAmount,
  sellFill,
} from '../src/index.js';
import { buyParams, CATEGORY, fakeTxid, POOL_OWNER, sellParams } from './support/fixtures.js';
import { provider } from './support/funding.js';

const POOL = { sats: 150_545_039n, tokens: 29_857n };
const poolUtxo = {
  txid: fakeTxid(0xaa),
  vout: 0,
  satoshis: POOL.sats,
  token: { category: CATEGORY, amount: POOL.tokens },
  ownerPkh: POOL_OWNER.pkh,
};

describe('execute fee constant', () => {
  it('is the largest measured execute size, and fits under the maxNetworkFee floor at 1 sat/B', () => {
    expect(EXECUTE_FEE_SIZE_BYTES).toBe(BigInt(MEASURED_EXECUTE_SIZES.buyP2sh32));
    expect(executeFee(1n, 2000n)).toBe(803n);
    expect(executeFee(1n, 2000n) <= MAX_NETWORK_FEE_FLOOR).toBe(true);
  });

  it('is clamped to the order allowance', () => {
    expect(executeFee(3n, 2000n)).toBe(2000n);
  });
});

describe('pinned supply', () => {
  it('matches what buildExecuteTransaction puts into the pool when built with the same absolute fee (buy)', () => {
    const params = buyParams({ minOut: 1n });
    const utxo = { txid: fakeTxid(0xbb), vout: 0, satoshis: 10_003_000n };
    const fee = executeFee(1n, params.maxNetworkFee);
    const supply = pinnedSupply({ side: 'buy', satoshis: utxo.satoshis, tokenAmount: 0n }, fee);
    const tx = buildExecuteTransaction(instantiateOrder(params, provider), utxo, poolUtxo, {
      fee: { kind: 'absolute', satoshis: fee },
    });
    expect(tx.execution.side === 'buy' && tx.execution.bchIn).toBe(supply);
    expect(tx.execution.side === 'buy' && tx.execution.tokensOut).toBe(buyFill(POOL, supply).tokensOut);
  });

  it('matches the sell payout: bchOut + 2000 - fee', () => {
    const params = sellParams({ minOut: 2001n });
    const utxo = {
      txid: fakeTxid(0xbc),
      vout: 0,
      satoshis: 2000n,
      token: { category: CATEGORY, amount: 30n },
    };
    const fee = executeFee(1n, params.maxNetworkFee);
    const order = { side: 'sell', satoshis: 2000n, tokenAmount: 30n } as const;
    const supply = pinnedSupply(order, fee);
    const tx = buildExecuteTransaction(instantiateOrder(params, provider), utxo, poolUtxo, {
      fee: { kind: 'absolute', satoshis: fee },
    });
    expect(supply).toBe(30n);
    expect(tx.execution.payoutSatoshis).toBe(recipientAmount(order, sellFill(POOL, supply).bchOut, fee));
  });
});
