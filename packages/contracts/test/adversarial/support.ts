import {
  binToHex,
  createVirtualMachineBch2026,
  flattenBinArray,
  generateSigningSerializationBch,
  hash256,
  hexToBin,
  type AuthenticationProgramStateBch,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import type { Artifact } from '@cashscript/utils';
import type { Utxo } from 'cashscript';
import { expect } from 'vitest';
import {
  buyFill,
  poolLockingBytecode,
  poolRedeemScript,
  poolUnlockingBytecode,
  sellFill,
  type CauldronPoolUtxo,
  type Order,
  type PoolReserves,
} from '@atprice/core';
import {
  contractUnlock,
  poolOutput,
  rawTransaction,
  tokenOutput,
  type Chain,
  type Key,
  type RawInput,
} from '../harness.js';

const standardVm = createVirtualMachineBch2026(true);

export type OrderUtxo = RawInput['utxo'];
export type Built = ReturnType<typeof rawTransaction>;

/** What evaluating one input in isolation produced. `require` is the failing CashScript require message. */
export type InputVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly require: string | undefined; readonly error: string };

const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_2DROP = 0x6d;
const OP_DROP = 0x75;
const OP_NIP = 0x77;
const CLEANUP_OPCODES = new Set([OP_ENDIF, OP_NIP, OP_ELSE, OP_DROP, OP_2DROP]);

const lastIndexWhere = <T>(items: readonly T[], predicate: (item: T) => boolean): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
};

/**
 * Same attribution CashScript's own debugger uses (cashscript/dist/debugging.js): take the redeem
 * script phase of the P2SH evaluation, find the step that raised the error (or the implicit final
 * verify), and look the instruction pointer up in the artifact's `debug.requires`.
 */
const attributeRequire = (
  artifact: Artifact,
  steps: readonly AuthenticationProgramStateBch[],
): string | undefined => {
  const redeemPhase = steps.slice(
    lastIndexWhere(steps, (step) => step.ip === 0 && step.controlStack.length === 0),
  );
  const executed = redeemPhase.filter((step) => step.controlStack.every((item) => item !== false));
  const finalStep = redeemPhase[redeemPhase.length - 1];
  const lastExecuted = finalStep?.error !== undefined ? finalStep : executed[executed.length - 1];
  if (lastExecuted === undefined) return undefined;
  const requires = artifact.debug?.requires ?? [];
  if (lastExecuted.error !== undefined) {
    const failingIp = lastExecuted.ip - 1;
    const instruction = lastExecuted.instructions[failingIp];
    const isNullFail = lastExecuted.error.includes('non-null signature');
    const isCheckSig = instruction !== undefined && [0xac, 0xae, 0xba].includes(instruction.opcode);
    const ip = failingIp + (isNullFail && isCheckSig ? 1 : 0);
    return requires.find((statement) => statement.ip === ip)?.message;
  }
  const instructions = executed.map((step) => step.instructions[step.ip]);
  let cleanup = 0;
  for (const instruction of [...instructions].reverse()) {
    if (instruction === undefined || CLEANUP_OPCODES.has(instruction.opcode)) cleanup += 1;
    else break;
  }
  const finalNonCleanup = executed[executed.length - 1 - cleanup];
  if (finalNonCleanup === undefined) return undefined;
  return requires.find((statement) => statement.ip === finalNonCleanup.ip + 1)?.message;
};

/** Evaluates a single input in the standard BCH_2026_05 VM and, when it fails, names the failing require. */
export const evaluateInput = (
  transaction: TransactionCommon,
  sourceOutputs: readonly Output[],
  inputIndex: number,
  artifact?: Artifact,
): InputVerdict => {
  const program = { inputIndex, sourceOutputs: [...sourceOutputs], transaction };
  const result = standardVm.stateSuccess(standardVm.evaluate(program));
  if (result === true) return { ok: true };
  const require = artifact === undefined ? undefined : attributeRequire(artifact, standardVm.debug(program));
  return { ok: false, require, error: result };
};

/** Whole-transaction verification in the standard VM (scripts, token rules, standardness, dust). */
export const verifyAll = (transaction: TransactionCommon, sourceOutputs: readonly Output[]): true | string =>
  standardVm.verify({ transaction, sourceOutputs: [...sourceOutputs] });

/**
 * Asserts the transaction is rejected as a whole and that the covenant input fails on exactly
 * `reason`. With `poolPasses`, also asserts the pool input on its own is valid, which proves the
 * covenant (not Cauldron) is what stops the attack.
 */
export const expectCovenantRejects = (
  built: Pick<Built, 'transaction' | 'sourceOutputs'>,
  order: Order,
  reason: string,
  options: { input?: number; poolPasses?: boolean } = {},
): void => {
  const input = options.input ?? 1;
  expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
  const verdict = evaluateInput(built.transaction, built.sourceOutputs, input, order.contract.artifact);
  expect(verdict.ok).toBe(false);
  expect(verdict.ok ? 'passed' : verdict.require).toBe(reason);
  if (options.poolPasses)
    expect(evaluateInput(built.transaction, built.sourceOutputs, 0)).toEqual({ ok: true });
};

/** Asserts the transaction passes the standard VM and is accepted by the mock network. */
export const expectAcceptedRaw = async (chain: Chain, built: Built): Promise<void> => {
  expect(verifyAll(built.transaction, built.sourceOutputs)).toBe(true);
  await chain.provider.sendRawTransaction(built.hex);
};

export const poolInput = (pool: CauldronPoolUtxo, unlock?: RawInput['unlock']): RawInput => ({
  utxo: { ...pool, lockingBytecode: pool.lockingBytecode ?? binToHex(poolLockingBytecode(pool.ownerPkh)) },
  unlock: unlock ?? poolUnlockingBytecode(pool.ownerPkh),
});

export const executeInput = (order: Order, utxo: OrderUtxo, poolPkh: Uint8Array): RawInput => ({
  utxo,
  unlock: contractUnlock(order.contract.unlock.execute(poolPkh)),
});

const reservesOf = (pool: CauldronPoolUtxo): PoolReserves => ({
  sats: pool.satoshis,
  tokens: pool.token.amount,
});

export interface BuyShape {
  readonly bchIn?: bigint;
  readonly tokensOut?: bigint;
  readonly payout?: Output;
  readonly poolOut?: Output;
  readonly extraOutputs?: readonly Output[];
  readonly extraInputs?: readonly RawInput[];
  readonly version?: number;
  readonly poolUnlock?: RawInput['unlock'];
  readonly poolPkh?: Uint8Array;
}

/** Default buy fill at a 1000-sat fee; every field can be overridden to build an attack. */
export const rawBuy = (
  order: Order,
  utxo: OrderUtxo,
  pool: CauldronPoolUtxo,
  shape: BuyShape = {},
): Built => {
  const bchIn = shape.bchIn ?? utxo.satoshis - 1000n - 1000n;
  const tokensOut = shape.tokensOut ?? buyFill(reservesOf(pool), bchIn).tokensOut;
  const after = { sats: pool.satoshis + bchIn, tokens: pool.token.amount - tokensOut };
  return rawTransaction(
    [
      poolInput(pool, shape.poolUnlock),
      executeInput(order, utxo, shape.poolPkh ?? pool.ownerPkh),
      ...(shape.extraInputs ?? []),
    ],
    [
      shape.poolOut ?? poolOutput(pool, after),
      shape.payout ??
        tokenOutput(order.params.recipientLockingBytecode, 1000n, order.params.tokenCategory, tokensOut),
      ...(shape.extraOutputs ?? []),
    ],
    shape.version,
  );
};

export interface SellShape {
  readonly bchOut?: bigint;
  readonly tokensIntoPool?: bigint;
  readonly payout?: Output;
  readonly payoutSats?: bigint;
  readonly poolOut?: Output;
  readonly version?: number;
}

/** Default sell fill at a 1000-sat fee; every field can be overridden to build an attack. */
export const rawSell = (
  order: Order,
  utxo: OrderUtxo,
  pool: CauldronPoolUtxo,
  shape: SellShape = {},
): Built => {
  const tokensIn = utxo.token?.amount ?? 0n;
  const tokensIntoPool = shape.tokensIntoPool ?? tokensIn;
  const bchOut = shape.bchOut ?? sellFill(reservesOf(pool), tokensIn).bchOut;
  const payoutSats = shape.payoutSats ?? bchOut + utxo.satoshis - 1000n;
  return rawTransaction(
    [poolInput(pool), executeInput(order, utxo, pool.ownerPkh)],
    [
      shape.poolOut ??
        poolOutput(pool, { sats: pool.satoshis - bchOut, tokens: pool.token.amount + tokensIntoPool }),
      shape.payout ?? { lockingBytecode: order.params.recipientLockingBytecode, valueSatoshis: payoutSats },
    ],
    shape.version,
  );
};

const push = (data: Uint8Array): Uint8Array => {
  if (data.length > 75) throw new RangeError('direct pushes only');
  return flattenBinArray([Uint8Array.of(data.length), data]);
};

/** SIGHASH_ALL | SIGHASH_UTXOS | FORKID. */
export const SIGHASH_ALL_UTXOS = 0x61;
/** SIGHASH_SINGLE | ANYONECANPAY | FORKID. */
export const SIGHASH_SINGLE_ANYONECANPAY = 0xc3;
/** SIGHASH_NONE | ANYONECANPAY | FORKID. */
export const SIGHASH_NONE_ANYONECANPAY = 0xc2;

/** A Schnorr signature of `inputIndex` over `coveredBytecode` with an explicit hash type. */
export const signInput = (
  key: Key,
  transaction: TransactionCommon,
  sourceOutputs: readonly Output[],
  inputIndex: number,
  coveredBytecode: Uint8Array,
  hashType: number,
): Uint8Array => {
  const preimage = generateSigningSerializationBch(
    { inputIndex, sourceOutputs: [...sourceOutputs], transaction },
    { coveredBytecode, signingSerializationType: Uint8Array.of(hashType) },
  );
  return Uint8Array.from([...key.signer.signMessageHash(hash256(preimage)), hashType]);
};

/** A genuine withdraw-branch unlocking of the pool, signed by its owner: `<sig> <pubkey> <redeemScript>`. */
export const poolWithdrawUnlock =
  (owner: Key): RawInput['unlock'] =>
  (transaction, sourceOutputs, inputIndex) => {
    const redeem = poolRedeemScript(owner.pkh);
    const sig = signInput(owner, transaction, sourceOutputs, inputIndex, redeem, SIGHASH_ALL_UTXOS);
    return flattenBinArray([push(sig), push(owner.publicKey), Uint8Array.of(0x44), redeem]);
  };

/** A P2PKH unlocking with an explicit hash type. */
export const p2pkhUnlock =
  (key: Key, hashType: number): RawInput['unlock'] =>
  (transaction, sourceOutputs, inputIndex) => {
    const sig = signInput(key, transaction, sourceOutputs, inputIndex, key.lockingBytecode, hashType);
    return flattenBinArray([push(sig), push(key.publicKey)]);
  };

/** A pool UTXO whose token also carries an NFT (which Chain.addPool cannot make). */
export const addNftPool = (
  chain: Chain,
  owner: Key,
  reserves: PoolReserves,
  category: string,
  nft: NonNullable<NonNullable<Utxo['token']>['nft']>,
): CauldronPoolUtxo => {
  const lockingBytecode = binToHex(poolLockingBytecode(owner.pkh));
  const token = { category, amount: reserves.tokens, nft };
  const utxo = chain.provider.addUtxo(lockingBytecode, {
    txid: binToHex(hash256(Uint8Array.from([...hexToBin(category), ...owner.pkh]))),
    vout: 0,
    satoshis: reserves.sats,
    token,
  });
  return { ...utxo, lockingBytecode, token, ownerPkh: owner.pkh };
};
