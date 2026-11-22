import {
  decodeOrderRecord,
  RecordDecodeError,
  RECORD_MAGIC,
  type OrderRecord,
  type RecordDecodeFailure,
} from '@atprice/core';
import { binToHex, type TransactionCommon } from '@bitauth/libauth';

const OP_RETURN = 0x6a;
const OP_1 = 0x51;
const OP_16 = 0x60;

/** What the OP_RETURN outputs of one transaction say about an AtPrice order. */
export type RecordScan =
  | { readonly kind: 'none' }
  | { readonly kind: 'record'; readonly record: OrderRecord; readonly recordHex: string }
  | { readonly kind: 'unknown_version'; readonly version: number; readonly recordHex: string }
  | {
      readonly kind: 'invalid';
      readonly reason: RecordDecodeFailure;
      readonly message: string;
      readonly recordHex: string;
    };

/** `OP_RETURN <push 4> "ATPR"`: the record's magic, before any field the version could change. */
const hasMagic = (bytecode: Uint8Array): boolean =>
  bytecode[0] === OP_RETURN &&
  bytecode[1] === RECORD_MAGIC.length &&
  RECORD_MAGIC.every((byte, index) => bytecode[2 + index] === byte);

/**
 * The version field right after the magic (`01 vv` or `OP_1..OP_16`). Core rejects versions it
 * doesn't implement without returning the number, and recover.md names the version in its message.
 */
const versionByte = (bytecode: Uint8Array): number | null => {
  const offset = 2 + RECORD_MAGIC.length;
  const opcode = bytecode[offset];
  if (opcode === undefined) return null;
  if (opcode >= OP_1 && opcode <= OP_16) return opcode - OP_1 + 1;
  if (opcode === 1) return bytecode[offset + 1] ?? null;
  return null;
};

/**
 * Finds the `ATPR` record of a funding transaction, decoded locally by `packages/core` (recover.md
 * hard rule 5). The first record wins; a transaction without one is `none`.
 */
export const scanRecords = (transaction: TransactionCommon): RecordScan => {
  for (const output of transaction.outputs) {
    const bytecode = output.lockingBytecode;
    if (!hasMagic(bytecode)) continue;
    const recordHex = binToHex(bytecode);
    try {
      return { kind: 'record', record: decodeOrderRecord(bytecode), recordHex };
    } catch (error) {
      if (!(error instanceof RecordDecodeError)) throw error;
      if (error.reason === 'unsupported_version') {
        const version = versionByte(bytecode);
        if (version !== null) return { kind: 'unknown_version', version, recordHex };
      }
      return { kind: 'invalid', reason: error.reason, message: error.message, recordHex };
    }
  }
  return { kind: 'none' };
};
