import {
  createVirtualMachineBch2026,
  decodeTransactionBch,
  encodeTransactionBch,
  hashTransaction,
  hexToBin,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { MIN_RELAY_FEE_PER_BYTE } from '../constants.js';
import { TransactionVerificationError } from '../errors.js';

/** A fully signed transaction ready to broadcast. */
export interface SignedTransaction {
  readonly hex: string;
  readonly txid: string;
  readonly size: number;
  readonly fee: bigint;
  readonly sourceOutputs: readonly Output[];
}

type StandardVm = ReturnType<typeof createVirtualMachineBch2026>;
let standardVm: StandardVm | undefined;
const vm = (): StandardVm => (standardVm ??= createVirtualMachineBch2026(true));

const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

export const decodeTransactionHex = (hex: string): TransactionCommon => {
  const decoded = decodeTransactionBch(hexToBin(hex));
  if (typeof decoded === 'string') throw new TransactionVerificationError('decode_failed', decoded);
  return decoded;
};

/**
 * Verifies a transaction in the libauth BCH_2026_05 VM with standard (relay) policy, which covers
 * every input script, standard output templates and dust, then checks the fee pays at least
 * `minFeePerByte` (the VM does not check fee rate).
 */
export const verifyTransaction = (
  hex: string,
  sourceOutputs: readonly Output[],
  minFeePerByte: bigint = MIN_RELAY_FEE_PER_BYTE,
): SignedTransaction => {
  const transaction = decodeTransactionHex(hex);
  if (transaction.inputs.length !== sourceOutputs.length) {
    throw new TransactionVerificationError(
      'source_output_count',
      `${transaction.inputs.length} inputs but ${sourceOutputs.length} source outputs`,
    );
  }
  const result = vm().verify({ transaction, sourceOutputs: [...sourceOutputs] });
  if (result !== true) throw new TransactionVerificationError('vm_rejected', result);
  const encoded = encodeTransactionBch(transaction);
  const size = encoded.length;
  const fee =
    sum(sourceOutputs.map((output) => output.valueSatoshis)) -
    sum(transaction.outputs.map((output) => output.valueSatoshis));
  if (fee < BigInt(size) * minFeePerByte) {
    throw new TransactionVerificationError(
      'fee_below_relay_minimum',
      `fee ${fee} is below ${minFeePerByte} sat/B for ${size} bytes`,
    );
  }
  return { hex, txid: hashTransaction(encoded), size, fee, sourceOutputs };
};
