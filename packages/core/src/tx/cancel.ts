import {
  binToHex,
  encodeLockingBytecodeP2pkh,
  getDustThreshold,
  hash160,
  type Output,
} from '@bitauth/libauth';
import {
  placeholderPublicKey,
  placeholderSignature,
  type PlaceholderP2PKHUnlocker,
  type SignatureTemplate,
  TransactionBuilder,
  type Unlocker,
  type Utxo,
} from 'cashscript';
import { bytesEqual } from '../bytes.js';
import { MIN_RELAY_FEE_PER_BYTE } from '../constants.js';
import { OwnerUtxoRequiredError, TransactionBuildError } from '../errors.js';
import type { Order } from '../order.js';
import { assertBuilderBurnsNoToken } from './tokens.js';
import { utxoSourceOutput } from './utxo.js';
import { verifyTransaction, type SignedTransaction } from './verify.js';
import { toWizardConnectDraft, type InputPath, type UnsignedTransactionDraft } from './wizardconnect.js';

/** An order covenant UTXO to refund. Any UTXO at the order address qualifies, whatever it holds. */
export interface CancelableOrder {
  readonly order: Order;
  readonly utxo: Utxo;
}

/**
 * The UTXOs at `P2PKH(ownerPkh)` (wallet `receive/addressIndex`) that `cancel()` may take its
 * authorizing input 0 from. Pass every UTXO the owner address holds: token UTXOs are never spent
 * (an address holding only token UTXOs counts as empty), and the builder picks the smallest
 * token-free one that covers what the cancel needs.
 */
export interface OwnerAuthorization {
  readonly utxos: readonly Utxo[];
  readonly addressIndex?: number;
}

interface CancelCommon {
  readonly orders: readonly CancelableOrder[];
  /** Miner fee rate in sat/B, default 1. */
  readonly feePerByte?: bigint;
}

export interface CancelRequest extends CancelCommon {
  readonly owner: OwnerAuthorization;
  readonly userPrompt?: string;
}

export interface CancelDraft extends UnsignedTransactionDraft {
  /** The owner UTXO the builder chose as input 0. */
  readonly ownerUtxo: Utxo;
}

export interface SignedCancelRequest extends CancelCommon {
  readonly owner: { readonly utxos: readonly Utxo[] };
  readonly ownerSigner: SignatureTemplate;
}

export interface CancelWithSigRequest extends CancelCommon {
  readonly ownerAddressIndex?: number;
  readonly userPrompt?: string;
}

export interface SignedCancelWithSigRequest extends CancelCommon {
  readonly ownerSigner: SignatureTemplate;
}

type Authorization =
  | { readonly kind: 'owner-input'; readonly utxo: Utxo; readonly unlocker: Unlocker }
  | { readonly kind: 'signature'; readonly sign: (order: Order) => Unlocker };

const MAX_FEE_ITERATIONS = 8;
const DEFAULT_CANCEL_PROMPT = 'Cancel AtPrice order';

const commonOwner = (orders: readonly CancelableOrder[]): Uint8Array => {
  const [first] = orders;
  if (first === undefined) throw new TransactionBuildError('no_orders', 'at least one order is required');
  const ownerPkh = first.order.params.ownerPkh;
  if (!orders.every(({ order }) => bytesEqual(order.params.ownerPkh, ownerPkh))) {
    throw new TransactionBuildError(
      'owner_mismatch',
      'every order in one cancel must belong to the same owner',
    );
  }
  return ownerPkh;
};

const withLocking = <T extends Utxo>(utxo: T, lockingBytecode: string): T & { lockingBytecode: string } => {
  if (utxo.lockingBytecode !== undefined && utxo.lockingBytecode !== lockingBytecode) {
    throw new TransactionBuildError(
      'owner_utxo_invalid',
      `UTXO ${utxo.txid}:${utxo.vout} is not locked where expected`,
    );
  }
  return { ...utxo, lockingBytecode };
};

const outputFor = (utxo: Utxo, lockingBytecode: Uint8Array, valueSatoshis: bigint): Output => {
  const source = utxoSourceOutput({ ...utxo, lockingBytecode: binToHex(lockingBytecode) });
  return { ...source, valueSatoshis };
};

interface FeeAllocation {
  readonly refunds: readonly bigint[];
  /** The part of the fee the order allowances cannot cover, taken from owner output 0 (`cancel()` only). */
  readonly ownerShortfall: bigint;
}

const dustOf = (utxo: Utxo, ownerLocking: Uint8Array): bigint =>
  getDustThreshold(outputFor(utxo, ownerLocking, utxo.satoshis));

/**
 * Splits the miner fee across the refunds, each at least `max(dust, V - maxNetworkFee)`. A stray
 * deposit worth little more than dust (or less) cannot pay its own way: whatever the allowances
 * leave uncovered is the owner shortfall, which `cancel()` takes from the owner pass-through
 * output 0 (the covenant leaves it unconstrained) and `cancelWithSig()` cannot pay at all.
 */
const allocateFee = (
  orders: readonly CancelableOrder[],
  ownerLocking: Uint8Array,
  fee: bigint,
): FeeAllocation => {
  const bounded = orders.map(({ order, utxo }) => {
    const dust = dustOf(utxo, ownerLocking);
    const covenantFloor = utxo.satoshis - order.params.maxNetworkFee;
    return { value: utxo.satoshis, floor: dust > covenantFloor ? dust : covenantFloor };
  });
  let shortfall = bounded.reduce((sum, { value, floor }) => (floor > value ? sum + floor - value : sum), fee);
  const refunds = bounded.map(({ value, floor }) => {
    if (floor >= value) return floor;
    const room = value - floor;
    const take = shortfall < room ? shortfall : room;
    shortfall -= take;
    return value - take;
  });
  return { refunds, ownerShortfall: shortfall };
};

const assemble = (
  orders: readonly CancelableOrder[],
  authorization: Authorization,
  allocation: FeeAllocation,
  ownerLocking: Uint8Array,
): TransactionBuilder => {
  const [first] = orders;
  if (first === undefined) throw new TransactionBuildError('no_orders', 'at least one order is required');
  const builder = new TransactionBuilder({
    provider: first.order.contract.provider,
    allowImplicitFungibleTokenBurn: false,
  });
  if (authorization.kind === 'owner-input') {
    builder.addInput(withLocking(authorization.utxo, binToHex(ownerLocking)), authorization.unlocker);
  }
  for (const { order, utxo } of orders) {
    const unlocker =
      authorization.kind === 'owner-input' ? order.contract.unlock.cancel() : authorization.sign(order);
    builder.addInput(withLocking(utxo, order.contract.lockingBytecode), unlocker);
  }
  if (authorization.kind === 'owner-input') {
    builder.addOutput({ to: ownerLocking, amount: authorization.utxo.satoshis - allocation.ownerShortfall });
  }
  orders.forEach(({ utxo }, index) => {
    const amount = allocation.refunds[index] ?? utxo.satoshis;
    builder.addOutput({ to: ownerLocking, amount, ...(utxo.token && { token: utxo.token }) });
  });
  return builder;
};

interface SettledCancel {
  readonly builder: TransactionBuilder;
  readonly allocation: FeeAllocation;
}

const settleFee = (
  orders: readonly CancelableOrder[],
  authorization: Authorization,
  ownerLocking: Uint8Array,
  feePerByte: bigint,
): SettledCancel => {
  let fee = 0n;
  for (let iteration = 0; iteration < MAX_FEE_ITERATIONS; iteration += 1) {
    const allocation = allocateFee(orders, ownerLocking, fee);
    if (authorization.kind === 'signature' && allocation.ownerShortfall > 0n) {
      throw new TransactionBuildError(
        'fee_exceeds_allowance',
        `the orders' fee allowances cannot cover a ${fee} sat fee with every refund above dust; use cancel() with an owner UTXO`,
      );
    }
    const builder = assemble(orders, authorization, allocation, ownerLocking);
    const required = builder.getTransactionSize() * feePerByte;
    if (fee >= required) return { builder, allocation };
    fee = required;
  }
  throw new TransactionBuildError(
    'fee_did_not_converge',
    `fee did not settle after ${MAX_FEE_ITERATIONS} rounds`,
  );
};

/** Larger than any real UTXO, so the sizing pass never runs owner output 0 below zero. */
const PROBE_OWNER_SATOSHIS = 21_000_000n * 100_000_000n;

/**
 * Picks `cancel()` input 0: the smallest token-free owner UTXO that can absorb the owner shortfall
 * and stay at or above dust. The transaction size does not depend on which owner UTXO is used, so
 * one sizing pass with a probe UTXO gives the exact requirement for all of them.
 */
const settleOwnerCancel = (
  orders: readonly CancelableOrder[],
  ownerUtxos: readonly Utxo[],
  unlocker: Unlocker,
  ownerLocking: Uint8Array,
  feePerByte: bigint,
): SettledCancel & { readonly ownerUtxo: Utxo } => {
  const lockingHex = binToHex(ownerLocking);
  const tokenFree = ownerUtxos
    .map((utxo) => withLocking(utxo, lockingHex))
    .filter((utxo) => utxo.token === undefined);
  const probe: Utxo = { txid: '00'.repeat(32), vout: 0, satoshis: PROBE_OWNER_SATOSHIS };
  const sizing = settleFee(orders, { kind: 'owner-input', utxo: probe, unlocker }, ownerLocking, feePerByte);
  const requiredSatoshis =
    getDustThreshold({ lockingBytecode: ownerLocking, valueSatoshis: 0n }) + sizing.allocation.ownerShortfall;
  const ownerUtxo = tokenFree
    .filter((utxo) => utxo.satoshis >= requiredSatoshis)
    .reduce<Utxo | undefined>(
      (best, utxo) => (best === undefined || utxo.satoshis < best.satoshis ? utxo : best),
      undefined,
    );
  if (ownerUtxo === undefined) {
    const largest = tokenFree.reduce((max, utxo) => (utxo.satoshis > max ? utxo.satoshis : max), 0n);
    throw new OwnerUtxoRequiredError(
      tokenFree.length === 0 ? 'owner_address_empty' : 'owner_utxo_too_small',
      requiredSatoshis,
      largest,
    );
  }
  const settled = settleFee(
    orders,
    { kind: 'owner-input', utxo: ownerUtxo, unlocker },
    ownerLocking,
    feePerByte,
  );
  return { ...settled, ownerUtxo };
};

const sourceOutputsOf = (
  orders: readonly CancelableOrder[],
  ownerUtxo: Utxo | undefined,
  ownerLocking: Uint8Array,
): Output[] => [
  ...(ownerUtxo === undefined ? [] : [utxoSourceOutput(withLocking(ownerUtxo, binToHex(ownerLocking)))]),
  ...orders.map(({ order, utxo }) => utxoSourceOutput(withLocking(utxo, order.contract.lockingBytecode))),
];

const ownerPlaceholder = (ownerLocking: Uint8Array): PlaceholderP2PKHUnlocker => ({
  generateUnlockingBytecode: () => new Uint8Array(),
  placeholder: true,
  lockingBytecode: binToHex(ownerLocking),
});

/**
 * `cancel()` for one or more orders of one owner, as an unsigned WizardConnect request. Input 0 is
 * a token-free owner P2PKH UTXO chosen from `owner.utxos` (the only input the wallet signs, listed
 * in `inputPaths`); order `k` is input `k + 1` with its refund at output `k + 1`; output 0 returns
 * the owner input, less any part of the fee the orders' allowances cannot cover (stray deposits
 * near dust), never below dust. Throws {@link OwnerUtxoRequiredError} when no owner UTXO fits.
 */
export const buildCancelTransaction = (request: CancelRequest): CancelDraft => {
  const ownerLocking = encodeLockingBytecodeP2pkh(commonOwner(request.orders));
  const { builder, ownerUtxo } = settleOwnerCancel(
    request.orders,
    request.owner.utxos,
    ownerPlaceholder(ownerLocking),
    ownerLocking,
    request.feePerByte ?? MIN_RELAY_FEE_PER_BYTE,
  );
  const inputPaths: InputPath[] = [[0, 'receive', request.owner.addressIndex ?? 0]];
  const draft = toWizardConnectDraft(builder, {
    inputPaths,
    contractInputs: [],
    userPrompt: request.userPrompt ?? DEFAULT_CANCEL_PROMPT,
  });
  return { ...draft, ownerUtxo };
};

/** `cancel()` signed locally with the owner key (tests and the CLI recovery tool). */
export const buildSignedCancelTransaction = (request: SignedCancelRequest): SignedTransaction => {
  const ownerLocking = encodeLockingBytecodeP2pkh(commonOwner(request.orders));
  assertSigner(request.ownerSigner, ownerLocking);
  const { builder, ownerUtxo } = settleOwnerCancel(
    request.orders,
    request.owner.utxos,
    request.ownerSigner.unlockP2PKH(),
    ownerLocking,
    request.feePerByte ?? MIN_RELAY_FEE_PER_BYTE,
  );
  return signedAndConserved(builder, sourceOutputsOf(request.orders, ownerUtxo, ownerLocking));
};

/**
 * `cancelWithSig()` for one or more orders of one owner, as an unsigned WizardConnect request for
 * wallets that fill CashScript placeholders. Order `k` is input `k` with its refund at output `k`.
 * Each covenant input carries `placeholderPublicKey()`/`placeholderSignature()`, its `contract`
 * info in `sourceOutputs`, and an `inputPaths` entry for the owner key.
 */
export const buildCancelWithSigTransaction = (request: CancelWithSigRequest): UnsignedTransactionDraft => {
  const ownerLocking = encodeLockingBytecodeP2pkh(commonOwner(request.orders));
  const { builder } = settleFee(
    request.orders,
    {
      kind: 'signature',
      sign: (order) => order.contract.unlock.cancelWithSig(placeholderPublicKey(), placeholderSignature()),
    },
    ownerLocking,
    request.feePerByte ?? MIN_RELAY_FEE_PER_BYTE,
  );
  const addressIndex = request.ownerAddressIndex ?? 0;
  const indexes = request.orders.map((_, index) => index);
  return toWizardConnectDraft(builder, {
    inputPaths: indexes.map((index): InputPath => [index, 'receive', addressIndex]),
    contractInputs: indexes,
    userPrompt: request.userPrompt ?? DEFAULT_CANCEL_PROMPT,
  });
};

/** `cancelWithSig()` signed locally with the owner key (tests and the CLI recovery tool). */
export const buildSignedCancelWithSigTransaction = (
  request: SignedCancelWithSigRequest,
): SignedTransaction => {
  const ownerLocking = encodeLockingBytecodeP2pkh(commonOwner(request.orders));
  assertSigner(request.ownerSigner, ownerLocking);
  const signer = request.ownerSigner;
  const { builder } = settleFee(
    request.orders,
    { kind: 'signature', sign: (order) => order.contract.unlock.cancelWithSig(signer.publicKey, signer) },
    ownerLocking,
    request.feePerByte ?? MIN_RELAY_FEE_PER_BYTE,
  );
  return signedAndConserved(builder, sourceOutputsOf(request.orders, undefined, ownerLocking));
};

const signedAndConserved = (
  builder: TransactionBuilder,
  sourceOutputs: readonly Output[],
): SignedTransaction => {
  assertBuilderBurnsNoToken(builder);
  return verifyTransaction(builder.build(), sourceOutputs);
};

const assertSigner = (signer: SignatureTemplate, ownerLocking: Uint8Array): void => {
  const signerLocking = encodeLockingBytecodeP2pkh(hash160(signer.publicKey));
  if (!bytesEqual(signerLocking, ownerLocking)) {
    throw new TransactionBuildError('owner_mismatch', 'the signing key is not the order owner');
  }
};
