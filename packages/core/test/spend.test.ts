import { binToHex, encodeTransactionBch, hexToBin, type TransactionCommon } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  buildExecuteTransaction,
  buildSignedCancelTransaction,
  buildSignedCancelWithSigTransaction,
  classifyOrderSpend,
  decodeTransactionHex,
  instantiateOrder,
  type OrderParams,
} from '../src/index.js';
import {
  buyParams,
  CATEGORY,
  fakeTxid,
  OWNER,
  POOL_OWNER,
  sellParams,
  STRANGER,
} from './support/fixtures.js';
import { provider } from './support/funding.js';

const pool = {
  txid: fakeTxid(0xaa),
  vout: 0,
  satoshis: 150_545_039n,
  token: { category: CATEGORY, amount: 29_857n },
  ownerPkh: POOL_OWNER.pkh,
};
const BUY_UTXO = { txid: fakeTxid(0xbb), vout: 0, satoshis: 10_003_000n };
const SELL_UTXO = {
  txid: fakeTxid(0xbc),
  vout: 0,
  satoshis: 2000n,
  token: { category: CATEGORY, amount: 30n },
};
const OWNER_UTXO = {
  txid: fakeTxid(0xcc),
  vout: 2,
  satoshis: 50_000n,
  lockingBytecode: binToHex(OWNER.lockingBytecode),
};

const executeOf = (params: OrderParams, utxo: typeof BUY_UTXO | typeof SELL_UTXO): TransactionCommon =>
  decodeTransactionHex(buildExecuteTransaction(instantiateOrder(params, provider), utxo, pool).hex);

describe('classifyOrderSpend', () => {
  it('recognises a buy execute and reports what the recipient got', () => {
    const params = buyParams({ minOut: 10n });
    const spend = classifyOrderSpend(executeOf(params, BUY_UTXO), 1, params, { satoshis: BUY_UTXO.satoshis });
    expect(spend.path).toBe('execute');
    if (spend.path !== 'execute') return;
    expect(spend.poolOwnerPkh).toBe(binToHex(POOL_OWNER.pkh));
    expect(spend.payoutSatoshis).toBe(1000n);
    expect(spend.delivered >= 10n).toBe(true);
    expect(spend.poolAfter.tokens + spend.delivered).toBe(pool.token.amount);
  });

  it('recognises a sell execute', () => {
    const params = sellParams({ minOut: 2001n });
    const spend = classifyOrderSpend(executeOf(params, SELL_UTXO), 1, params, SELL_UTXO);
    expect(spend.path === 'execute' && spend.delivered === spend.payoutSatoshis).toBe(true);
  });

  it('recognises cancel() and cancelWithSig() and re-verifies the refund', () => {
    const params = sellParams();
    const order = instantiateOrder(params, provider);
    const viaOwnerInput = buildSignedCancelTransaction({
      owner: { utxos: [OWNER_UTXO] },
      orders: [{ order, utxo: SELL_UTXO }],
      ownerSigner: OWNER.signer,
    });
    expect(classifyOrderSpend(decodeTransactionHex(viaOwnerInput.hex), 1, params, SELL_UTXO)).toEqual({
      path: 'cancel',
      authorization: 'cancel',
      refundVout: 1,
    });
    const viaSignature = buildSignedCancelWithSigTransaction({
      orders: [{ order, utxo: SELL_UTXO }],
      ownerSigner: OWNER.signer,
    });
    expect(classifyOrderSpend(decodeTransactionHex(viaSignature.hex), 0, params, SELL_UTXO)).toEqual({
      path: 'cancel',
      authorization: 'cancelWithSig',
      refundVout: 0,
    });
  });

  it('calls a spend unknown when the redeem script belongs to another order', () => {
    const params = buyParams({ minOut: 10n });
    const tx = executeOf(params, BUY_UTXO);
    expect(classifyOrderSpend(tx, 1, buyParams({ minOut: 11n }), BUY_UTXO)).toEqual({
      path: 'unknown',
      reason: 'not_order_redeem_script',
    });
  });

  it('calls an execute with a redirected payout unknown', () => {
    const params = buyParams({ minOut: 10n });
    const tx = executeOf(params, BUY_UTXO);
    const tampered: TransactionCommon = {
      ...tx,
      outputs: tx.outputs.map((output, index) =>
        index === 1 ? { ...output, lockingBytecode: STRANGER.lockingBytecode } : output,
      ),
    };
    expect(classifyOrderSpend(tampered, 1, params, BUY_UTXO)).toEqual({
      path: 'unknown',
      reason: 'execute_shape',
    });
  });

  it('calls a cancel whose refund drops the tokens unknown', () => {
    const params = sellParams();
    const signed = buildSignedCancelWithSigTransaction({
      orders: [{ order: instantiateOrder(params, provider), utxo: SELL_UTXO }],
      ownerSigner: OWNER.signer,
    });
    const tx = decodeTransactionHex(signed.hex);
    const stripped = decodeTransactionHex(
      binToHex(
        encodeTransactionBch({
          ...tx,
          outputs: tx.outputs.map(({ token: _token, ...rest }) => rest),
        }),
      ),
    );
    expect(classifyOrderSpend(stripped, 0, params, SELL_UTXO)).toEqual({
      path: 'unknown',
      reason: 'cancel_shape',
    });
  });

  it('rejects malformed unlocking bytecode', () => {
    const params = buyParams();
    const tx = executeOf(buyParams({ minOut: 10n }), BUY_UTXO);
    const broken: TransactionCommon = {
      ...tx,
      inputs: tx.inputs.map((input, index) =>
        index === 1 ? { ...input, unlockingBytecode: hexToBin('4c') } : input,
      ),
    };
    expect(classifyOrderSpend(broken, 1, params, BUY_UTXO).path).toBe('unknown');
  });
});
