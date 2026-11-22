import {
  binToHex,
  createVirtualMachineBch2026,
  encodeLockingBytecodeP2sh32,
  flattenBinArray,
  hash256,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  buyFill,
  CAULDRON_V0_PREFIX,
  CAULDRON_V0_SUFFIX,
  type Order,
  type PoolReserves,
} from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  orderParams,
  OWNER,
  POOL_OWNER,
  rawTransaction,
  tokenOutput,
  type RawInput,
} from '../harness.js';
import {
  evaluateInput,
  executeInput,
  expectAcceptedRaw,
  expectCovenantRejects,
  rawBuy,
  verifyAll,
  type OrderUtxo,
} from './support.js';

const POOL: PoolReserves = { sats: 150_545_039n, tokens: 29_857n };
const VALUE = 10_003_000n;
const BCH_IN = VALUE - 2000n;
const BEST = buyFill(POOL, BCH_IN);

const setup = () => {
  const chain = new Chain();
  const pool = chain.addPool(POOL);
  const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: VALUE });
  return { chain, pool, order, utxo };
};

const OP_0 = 0x00;
const OP_EQUALVERIFY = 0x88;
const OP_SIZE = 0x82;

/** The opcode that raised the error while evaluating `inputIndex`, and the one before it. */
const failingInstruction = (
  built: { transaction: TransactionCommon; sourceOutputs: Output[] },
  inputIndex: number,
): { opcode: number | undefined; previous: number | undefined } => {
  const steps = createVirtualMachineBch2026(true).debug({
    inputIndex,
    sourceOutputs: built.sourceOutputs,
    transaction: built.transaction,
  });
  const failed = steps.find((step) => step.error !== undefined);
  const ip = (failed?.ip ?? 0) - 1;
  return { opcode: failed?.instructions[ip]?.opcode, previous: failed?.instructions[ip - 2]?.opcode };
};
const PKH_PUSH = 0x14;

/**
 * The genuine execute unlocking is `14 <poolPkh:20> 00 <redeem push>`. This rewrites the poolPkh
 * argument and the function selector, keeping the redeem script push.
 */
const forgedExecute =
  (order: Order, poolPkhArg: Uint8Array, selector: Uint8Array = Uint8Array.of(OP_0)): RawInput['unlock'] =>
  (transaction: TransactionCommon, sourceOutputs: Output[], inputIndex: number) => {
    const genuine = contractUnlock(order.contract.unlock.execute(new Uint8Array(20).fill(0x01)))(
      transaction,
      sourceOutputs,
      inputIndex,
    );
    expect(genuine[0]).toBe(PKH_PUSH);
    expect(genuine[21]).toBe(OP_0);
    return flattenBinArray([Uint8Array.of(poolPkhArg.length), poolPkhArg, selector, genuine.slice(22)]);
  };

/** A UTXO locked to P2SH32 of `PREFIX ‖ poolPkhArg ‖ SUFFIX`, which only a 20-byte arg makes a Cauldron pool. */
const lookalikePool = (chain: Chain, poolPkhArg: Uint8Array) => {
  const script = flattenBinArray([CAULDRON_V0_PREFIX, poolPkhArg, CAULDRON_V0_SUFFIX]);
  const lockingBytecode = encodeLockingBytecodeP2sh32(hash256(script));
  const utxo = chain.provider.addUtxo(binToHex(lockingBytecode), {
    txid: binToHex(hash256(script)),
    vout: 0,
    satoshis: POOL.sats,
    token: { category: CATEGORY, amount: POOL.tokens },
  });
  return {
    input: {
      utxo: { ...utxo, lockingBytecode: binToHex(lockingBytecode) },
      unlock: flattenBinArray([Uint8Array.of(0x44), script]),
    } satisfies RawInput,
    lockingBytecode,
  };
};

const lookalikeFill = (chain: Chain, order: Order, utxo: OrderUtxo, poolPkhArg: Uint8Array) => {
  const pool = lookalikePool(chain, poolPkhArg);
  return rawTransaction(
    [pool.input, { utxo, unlock: forgedExecute(order, poolPkhArg) }],
    [
      tokenOutput(pool.lockingBytecode, POOL.sats + BCH_IN, CATEGORY, 1n),
      tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, POOL.tokens - 1n),
    ],
  );
};

describe('adversarial execute arguments: poolPkh length games', () => {
  it('positive control: the forged unlocker with the genuine 20-byte pool hash is accepted', async () => {
    // #given the real pool and the rewritten unlocking with a correct 20-byte argument
    const { chain, pool, order, utxo } = setup();
    const base = rawBuy(order, utxo, pool);
    const built = rawTransaction(
      [
        {
          utxo: { ...pool, lockingBytecode: pool.lockingBytecode ?? '' },
          unlock: base.transaction.inputs[0]?.unlockingBytecode ?? new Uint8Array(),
        },
        { utxo, unlock: forgedExecute(order, POOL_OWNER.pkh) },
      ],
      base.transaction.outputs,
    );
    // #then the whole transaction is accepted, so the rewrite itself is sound
    await expectAcceptedRaw(chain, built);
  });

  it.each([19, 21, 32])(
    'a %i-byte poolPkh makes a non-Cauldron "pool" script that consensus refuses to spend through a 0x44 push',
    (length) => {
      // #given an attacker-made UTXO at P2SH32(PREFIX ‖ arg ‖ SUFFIX) for an arg of the wrong length
      const { chain, order, utxo } = setup();
      const built = lookalikeFill(chain, order, utxo, new Uint8Array(length).fill(0x77));
      // #then the transaction is invalid, and input 0 is what fails: 0x44 pushes 68 bytes, so the
      // unlocking is either truncated (< 20) or leaves the suffix's trailing OP_ENDIF as a non-push
      expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
      expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
    },
  );

  it.each([19, 21, 32])(
    'the covenant input also refuses a %i-byte poolPkh on its own (cashc bytes20 check: OP_SIZE 14 OP_EQUALVERIFY)',
    (length) => {
      // #given the same lookalike fill
      const { chain, order, utxo } = setup();
      const built = lookalikeFill(chain, order, utxo, new Uint8Array(length).fill(0x77));
      // #when the order input is evaluated alone
      const verdict = evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact);
      // #then it fails before the first named require, at the `OP_SIZE 14 OP_EQUALVERIFY` cashc emits
      expect(verdict.ok).toBe(false);
      expect(failingInstruction(built, 1)).toEqual({ opcode: OP_EQUALVERIFY, previous: OP_SIZE });
    },
  );
});

describe('adversarial execute arguments: function selector and input-0 impersonation', () => {
  it.each([
    ['OP_3', Uint8Array.of(0x53)],
    ['OP_1NEGATE', Uint8Array.of(0x4f)],
  ])('rejects an unknown function selector %s', (_name, selector) => {
    const { pool, order, utxo } = setup();
    const base = rawBuy(order, utxo, pool);
    const built = rawTransaction(
      [
        {
          utxo: { ...pool, lockingBytecode: pool.lockingBytecode ?? '' },
          unlock: base.transaction.inputs[0]?.unlockingBytecode ?? new Uint8Array(),
        },
        { utxo, unlock: forgedExecute(order, POOL_OWNER.pkh, selector) },
      ],
      base.transaction.outputs,
    );
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact).ok).toBe(false);
  });

  it('rejects another AtPrice order of the same owner posing as the pool at input 0', () => {
    const { chain, order, utxo } = setup();
    const decoy = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(5, 5, 5, 5, 5, 5, 5, 5) }), {
      satoshis: VALUE,
    });
    const built = rawTransaction(
      [executeInput(decoy.order, decoy.utxo, POOL_OWNER.pkh), executeInput(order, utxo, POOL_OWNER.pkh)],
      [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: VALUE },
        tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut),
      ],
    );
    expectCovenantRejects(built, order, 'input 0 is not a Cauldron V0 pool');
  });
});
