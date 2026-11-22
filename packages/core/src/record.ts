import { bigIntToBinUint64LE, binToBigIntUint64LE, flattenBinArray, utf8ToBin } from '@bitauth/libauth';
import { bytesEqual, tokenCategoryFromVmBytes, tokenCategoryToVmBytes } from './bytes.js';
import { MAX_INT64 } from './constants.js';
import { InvalidOrderParamsError, RecordDecodeError } from './errors.js';
import type { OrderParams, OrderSide } from './order.js';

export const RECORD_MAGIC: Uint8Array = utf8ToBin('ATPR');
export const RECORD_VERSION = 1;
/** Record lengths for each recipient template (contract spec, funding transaction). */
export const RECORD_LENGTH_P2PKH = 117;
export const RECORD_LENGTH_P2SH32 = 127;

const OP_RETURN = 0x6a;
const OP_1 = 0x51;
const OP_16 = 0x60;
const MAX_DIRECT_PUSH = 0x4b;
const RECIPIENT_LENGTHS: readonly number[] = [25, 23, 35];
const RECORD_FIELD_COUNT = 9;
const SIDE_BYTE: Record<OrderSide, number> = { buy: 0x00, sell: 0x01 };

const push = (data: Uint8Array): Uint8Array => {
  if (data.length < 1 || data.length > MAX_DIRECT_PUSH)
    throw new RangeError(`record field of ${data.length} bytes`);
  return flattenBinArray([Uint8Array.of(data.length), data]);
};

const uint64 = (value: bigint, field: string): Uint8Array => {
  if (value < 0n || value > MAX_INT64) {
    throw new InvalidOrderParamsError(
      field === 'minOut' ? 'min_out_range' : 'max_network_fee_range',
      `${field} does not fit the record`,
    );
  }
  return bigIntToBinUint64LE(value);
};

/**
 * Encodes the funding record as OP_RETURN locking bytecode. One-byte fields are always written as
 * `01 xx` pushes (never `OP_0`/`OP_N`), so a P2PKH recipient gives exactly 117 bytes.
 */
export const encodeOrderRecord = (params: OrderParams): Uint8Array => {
  if (!RECIPIENT_LENGTHS.includes(params.recipientLockingBytecode.length)) {
    throw new InvalidOrderParamsError('recipient_template', 'recipient must be P2PKH, P2SH20 or P2SH32');
  }
  if (params.ownerPkh.length !== 20)
    throw new InvalidOrderParamsError('owner_pkh_length', 'ownerPkh must be 20 bytes');
  if (params.nonce.length !== 8) throw new InvalidOrderParamsError('nonce_length', 'nonce must be 8 bytes');
  return flattenBinArray([
    Uint8Array.of(OP_RETURN),
    push(RECORD_MAGIC),
    push(Uint8Array.of(RECORD_VERSION)),
    push(Uint8Array.of(SIDE_BYTE[params.side])),
    push(params.ownerPkh),
    push(tokenCategoryToVmBytes(params.tokenCategory)),
    push(uint64(params.minOut, 'minOut')),
    push(uint64(params.maxNetworkFee, 'maxNetworkFee')),
    push(params.nonce),
    push(params.recipientLockingBytecode),
  ]);
};

export interface OrderRecord extends OrderParams {
  readonly version: typeof RECORD_VERSION;
}

interface Push {
  readonly data: Uint8Array;
  /** True when the field was written as `OP_1`..`OP_16`. */
  readonly smallInteger: boolean;
}

/** Reads one push: a direct push of 1-75 bytes, or `OP_1`..`OP_16`. Anything else is not minimal for this record. */
const readPush = (bytecode: Uint8Array, offset: number): { push: Push; next: number } => {
  const opcode = bytecode[offset];
  if (opcode === undefined) throw new RecordDecodeError('missing_field', 'record ends before all fields');
  if (opcode >= OP_1 && opcode <= OP_16) {
    return { push: { data: Uint8Array.of(opcode - OP_1 + 1), smallInteger: true }, next: offset + 1 };
  }
  if (opcode === 0x00 || opcode > MAX_DIRECT_PUSH) {
    throw new RecordDecodeError(
      'non_minimal_push',
      `opcode 0x${opcode.toString(16)} at byte ${offset} is not an accepted push`,
    );
  }
  const end = offset + 1 + opcode;
  if (end > bytecode.length)
    throw new RecordDecodeError('malformed_push', `push at byte ${offset} runs past the end`);
  return { push: { data: bytecode.slice(offset + 1, end), smallInteger: false }, next: end };
};

const exact = (field: Push, length: number, name: string): Uint8Array => {
  if (field.smallInteger || field.data.length !== length) {
    throw new RecordDecodeError('field_length', `${name} must be a ${length}-byte push`);
  }
  return field.data;
};

const oneByte = (field: Push, name: string): number => {
  const [value] = field.data;
  if (field.data.length !== 1 || value === undefined) {
    throw new RecordDecodeError('field_length', `${name} must be one byte`);
  }
  return value;
};

/** Decodes an OP_RETURN locking bytecode into an order record, rejecting anything not exactly per spec. */
export const decodeOrderRecord = (lockingBytecode: Uint8Array): OrderRecord => {
  if (lockingBytecode[0] !== OP_RETURN)
    throw new RecordDecodeError('not_op_return', 'output is not OP_RETURN');
  const fields: Push[] = [];
  let offset = 1;
  for (let index = 0; index < RECORD_FIELD_COUNT; index += 1) {
    const { push: field, next } = readPush(lockingBytecode, offset);
    fields.push(field);
    offset = next;
  }
  if (offset !== lockingBytecode.length)
    throw new RecordDecodeError('trailing_bytes', 'bytes follow the recipient field');
  const [magic, version, side, ownerPkh, category, minOut, maxNetworkFee, nonce, recipient] = fields as [
    Push,
    Push,
    Push,
    Push,
    Push,
    Push,
    Push,
    Push,
    Push,
  ];
  if (!bytesEqual(magic.data, RECORD_MAGIC) || magic.smallInteger)
    throw new RecordDecodeError('bad_magic', 'not an ATPR record');
  if (oneByte(version, 'version') !== RECORD_VERSION) {
    throw new RecordDecodeError(
      'unsupported_version',
      `record version ${version.data[0] ?? ''} is not supported`,
    );
  }
  const sideByte = oneByte(side, 'side');
  if (sideByte !== SIDE_BYTE.buy && sideByte !== SIDE_BYTE.sell) {
    throw new RecordDecodeError('invalid_side', `side byte ${sideByte} is neither buy nor sell`);
  }
  if (recipient.smallInteger || !RECIPIENT_LENGTHS.includes(recipient.data.length)) {
    throw new RecordDecodeError('field_length', 'recipient must be 25, 23 or 35 bytes');
  }
  return {
    version: RECORD_VERSION,
    side: sideByte === SIDE_BYTE.buy ? 'buy' : 'sell',
    ownerPkh: exact(ownerPkh, 20, 'ownerPkh'),
    tokenCategory: tokenCategoryFromVmBytes(exact(category, 32, 'tokenCategory')),
    minOut: binToBigIntUint64LE(exact(minOut, 8, 'minOut')),
    maxNetworkFee: binToBigIntUint64LE(exact(maxNetworkFee, 8, 'maxNetworkFee')),
    nonce: exact(nonce, 8, 'nonce'),
    recipientLockingBytecode: recipient.data,
  };
};
