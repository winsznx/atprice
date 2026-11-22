import { binToHex, flattenBinArray, hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  decodeOrderRecord,
  encodeOrderRecord,
  RECORD_LENGTH_P2PKH,
  RECORD_LENGTH_P2SH32,
  RecordDecodeError,
  type OrderParams,
  type RecordDecodeFailure,
} from '../src/index.js';
import {
  buyParams,
  CATEGORY,
  OWNER,
  P2SH20_RECIPIENT,
  P2SH32_RECIPIENT,
  sellParams,
} from './support/fixtures.js';
import { Random } from './support/random.js';

const expectFailure = (bytecode: Uint8Array, reason: RecordDecodeFailure): void => {
  let caught: unknown;
  try {
    decodeOrderRecord(bytecode);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RecordDecodeError);
  expect((caught as RecordDecodeError).reason).toBe(reason);
};

const roundTrip = (params: OrderParams): void => {
  const decoded = decodeOrderRecord(encodeOrderRecord(params));
  expect(decoded).toEqual({ version: 1, ...params });
};

describe('encodeOrderRecord', () => {
  it('writes the exact layout with a P2PKH recipient (117 bytes)', () => {
    const params = buyParams({ minOut: 0x0102n, maxNetworkFee: 2000n });
    const record = encodeOrderRecord(params);
    expect(record.length).toBe(RECORD_LENGTH_P2PKH);
    const categoryVm = binToHex(hexToBin(CATEGORY).reverse());
    expect(binToHex(record)).toBe(
      [
        '6a',
        '0441545052',
        '0101',
        '0100',
        `14${binToHex(OWNER.pkh)}`,
        `20${categoryVm}`,
        '080201000000000000',
        '08d007000000000000',
        '080908070605040302',
        `19${binToHex(OWNER.lockingBytecode)}`,
      ].join(''),
    );
  });

  it('is 127 bytes with a P2SH32 recipient and 115 with P2SH20', () => {
    expect(encodeOrderRecord(sellParams({ recipientLockingBytecode: P2SH32_RECIPIENT })).length).toBe(
      RECORD_LENGTH_P2SH32,
    );
    expect(encodeOrderRecord(sellParams({ recipientLockingBytecode: P2SH20_RECIPIENT })).length).toBe(115);
  });

  it('writes the sell side as 01 01', () => {
    expect(binToHex(encodeOrderRecord(sellParams())).slice(14, 18)).toBe('0101');
  });
});

describe('decodeOrderRecord', () => {
  it('round-trips 2000 random records across sides and recipient templates', () => {
    const random = new Random(0x7ec0n);
    const recipients = [OWNER.lockingBytecode, P2SH20_RECIPIENT, P2SH32_RECIPIENT];
    for (let index = 0; index < 2000; index += 1) {
      roundTrip({
        side: random.between(0n, 1n) === 0n ? 'buy' : 'sell',
        ownerPkh: random.bytes(20),
        recipientLockingBytecode: recipients[Number(random.between(0n, 2n))] ?? OWNER.lockingBytecode,
        tokenCategory: binToHex(random.bytes(32)),
        minOut: random.between(1n, 2n ** 63n - 1n),
        maxNetworkFee: random.between(0n, 2n ** 63n - 1n),
        nonce: random.bytes(8),
      });
    }
  });

  it('accepts OP_1 for the version and sell side (minimal pushes)', () => {
    const record = encodeOrderRecord(sellParams());
    const minimal = flattenBinArray([record.slice(0, 6), Uint8Array.of(0x51, 0x51), record.slice(10)]);
    expect(minimal.length).toBe(record.length - 2);
    expect(decodeOrderRecord(minimal)).toEqual(decodeOrderRecord(record));
  });

  it('rejects OP_0 for the buy side', () => {
    const record = encodeOrderRecord(buyParams());
    expectFailure(
      flattenBinArray([record.slice(0, 8), Uint8Array.of(0x00), record.slice(10)]),
      'non_minimal_push',
    );
  });

  it('rejects a non-OP_RETURN output', () => {
    expectFailure(OWNER.lockingBytecode, 'not_op_return');
  });

  it('rejects trailing bytes', () => {
    expectFailure(flattenBinArray([encodeOrderRecord(buyParams()), Uint8Array.of(0x51)]), 'trailing_bytes');
  });

  it('rejects a truncated record', () => {
    const record = encodeOrderRecord(buyParams());
    expectFailure(record.slice(0, record.length - 1), 'malformed_push');
    expectFailure(record.slice(0, 50), 'malformed_push');
    expectFailure(record.slice(0, 91), 'missing_field');
  });

  it('rejects another magic, an unknown version and an unknown side', () => {
    const record = encodeOrderRecord(buyParams());
    const patch = (offset: number, byte: number): Uint8Array => {
      const copy = record.slice();
      copy[offset] = byte;
      return copy;
    };
    expectFailure(patch(2, 0x42), 'bad_magic');
    expectFailure(patch(7, 0x02), 'unsupported_version');
    expectFailure(patch(9, 0x02), 'invalid_side');
  });

  it('rejects fields of the wrong length', () => {
    const record = encodeOrderRecord(buyParams());
    const shortPkh = flattenBinArray([record.slice(0, 10), Uint8Array.of(0x13), record.slice(12)]);
    expectFailure(shortPkh, 'field_length');
    const longVersion = flattenBinArray([
      record.slice(0, 6),
      Uint8Array.of(0x02, 0x01, 0x00),
      record.slice(8),
    ]);
    expectFailure(longVersion, 'field_length');
  });

  it('rejects a recipient that is not 25, 23 or 35 bytes', () => {
    const record = encodeOrderRecord(buyParams());
    const body = record.slice(0, RECORD_LENGTH_P2PKH - 26);
    expectFailure(
      flattenBinArray([body, Uint8Array.of(0x18), OWNER.lockingBytecode.slice(0, 24)]),
      'field_length',
    );
  });

  it('rejects PUSHDATA1 encodings of short fields', () => {
    const record = encodeOrderRecord(buyParams());
    const pushdata = flattenBinArray([record.slice(0, 10), Uint8Array.of(0x4c, 0x14), record.slice(11)]);
    expectFailure(pushdata, 'non_minimal_push');
  });
});
