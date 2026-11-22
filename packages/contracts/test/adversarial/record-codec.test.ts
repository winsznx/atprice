import { flattenBinArray } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  decodeOrderRecord,
  encodeOrderRecord,
  InvalidOrderParamsError,
  RecordDecodeError,
  validateOrderParams,
  type OrderParamsViolation,
  type RecordDecodeFailure,
} from '@atprice/core';
import { CATEGORY, orderParams, P2SH32_RECIPIENT } from '../harness.js';

const DOMAIN = { supportedTokenCategories: [CATEGORY] };
const PARAMS = orderParams('buy', { minOut: 1234n });
const RECORD = encodeOrderRecord(PARAMS);

/** Field offsets inside the canonical 117-byte P2PKH record (each field is `len ‖ data`). */
const FIELD_LENGTHS = [4, 1, 1, 20, 32, 8, 8, 8, 25] as const;
const fieldStart = (field: number): number =>
  1 + FIELD_LENGTHS.slice(0, field).reduce((sum, length) => sum + 1 + length, 0);

const decodeFailure = (bytecode: Uint8Array): RecordDecodeFailure | 'decoded' => {
  try {
    decodeOrderRecord(bytecode);
    return 'decoded';
  } catch (error) {
    expect(error).toBeInstanceOf(RecordDecodeError);
    return (error as RecordDecodeError).reason;
  }
};

const validationFailure = (bytecode: Uint8Array): OrderParamsViolation | 'valid' => {
  const record = decodeOrderRecord(bytecode);
  try {
    validateOrderParams(record, DOMAIN);
    return 'valid';
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidOrderParamsError);
    return (error as InvalidOrderParamsError).reason;
  }
};

/** Replaces field `field` (push opcode and data) with `replacement`. */
const replaceField = (field: number, replacement: Uint8Array): Uint8Array => {
  const start = fieldStart(field);
  const end = start + 1 + (FIELD_LENGTHS[field] ?? 0);
  return flattenBinArray([RECORD.slice(0, start), replacement, RECORD.slice(end)]);
};

const pushOf = (length: number, fill = 0x11): Uint8Array =>
  Uint8Array.from([length, ...new Uint8Array(length).fill(fill)]);

describe('adversarial record codec: positive controls', () => {
  it('round-trips the canonical record and it validates', () => {
    expect(decodeOrderRecord(RECORD)).toEqual({ version: 1, ...PARAMS });
    expect(validationFailure(RECORD)).toBe('valid');
  });

  it('accepts OP_1 for the version byte and OP_1 for a sell side byte', () => {
    const sell = encodeOrderRecord(orderParams('sell'));
    const minimal = flattenBinArray([sell.slice(0, 6), Uint8Array.of(0x51, 0x51), sell.slice(10)]);
    expect(decodeOrderRecord(minimal)).toEqual(decodeOrderRecord(sell));
  });
});

describe('adversarial record codec: framing attacks', () => {
  it.each([
    ['one trailing byte', flattenBinArray([RECORD, Uint8Array.of(0x00)]), 'trailing_bytes'],
    ['a trailing extra push', flattenBinArray([RECORD, Uint8Array.of(0x01, 0x01)]), 'trailing_bytes'],
    ['truncated by one byte', RECORD.slice(0, -1), 'malformed_push'],
    ['recipient field missing', RECORD.slice(0, fieldStart(8)), 'missing_field'],
    ['not an OP_RETURN', Uint8Array.from([0x51, ...RECORD.slice(1)]), 'not_op_return'],
    ['empty bytecode', new Uint8Array(), 'not_op_return'],
    ['bare OP_RETURN', Uint8Array.of(0x6a), 'missing_field'],
  ] as const)('rejects %s', (_name, bytecode, reason) => {
    expect(decodeFailure(bytecode)).toBe(reason);
  });

  it('rejects OP_PUSHDATA1 for every field', () => {
    for (let field = 0; field < FIELD_LENGTHS.length; field += 1) {
      const length = FIELD_LENGTHS[field] ?? 0;
      const original = RECORD.slice(fieldStart(field) + 1, fieldStart(field) + 1 + length);
      const pushdata = flattenBinArray([Uint8Array.of(0x4c, length), original]);
      expect(decodeFailure(replaceField(field, pushdata))).toBe('non_minimal_push');
    }
  });

  it('rejects OP_0, OP_1NEGATE and OP_RESERVED in a one-byte field', () => {
    for (const opcode of [0x00, 0x4f, 0x50]) {
      expect(decodeFailure(replaceField(2, Uint8Array.of(opcode)))).toBe('non_minimal_push');
    }
  });

  it('rejects a wrong magic, including a magic of the right letters in another case', () => {
    expect(decodeFailure(replaceField(0, Uint8Array.of(4, 0x61, 0x74, 0x70, 0x72)))).toBe('bad_magic');
    expect(decodeFailure(replaceField(0, Uint8Array.of(5, 0x41, 0x54, 0x50, 0x52, 0x00)))).toBe('bad_magic');
  });

  it('rejects version 0, version 2 and version via OP_2', () => {
    expect(decodeFailure(replaceField(1, Uint8Array.of(1, 0x00)))).toBe('unsupported_version');
    expect(decodeFailure(replaceField(1, Uint8Array.of(1, 0x02)))).toBe('unsupported_version');
    expect(decodeFailure(replaceField(1, Uint8Array.of(0x52)))).toBe('unsupported_version');
  });

  it('rejects side bytes 0x02 and OP_2, and a two-byte side', () => {
    expect(decodeFailure(replaceField(2, Uint8Array.of(1, 0x02)))).toBe('invalid_side');
    expect(decodeFailure(replaceField(2, Uint8Array.of(0x52)))).toBe('invalid_side');
    expect(decodeFailure(replaceField(2, Uint8Array.of(2, 0x00, 0x00)))).toBe('field_length');
  });
});

describe('adversarial record codec: wrong field lengths', () => {
  it.each([
    ['ownerPkh 19', 3, 19],
    ['ownerPkh 21', 3, 21],
    ['tokenCategory 31', 4, 31],
    ['tokenCategory 33', 4, 33],
    ['minOut 7', 5, 7],
    ['minOut 9', 5, 9],
    ['maxNetworkFee 7', 6, 7],
    ['maxNetworkFee 9', 6, 9],
    ['nonce 7', 7, 7],
    ['nonce 9', 7, 9],
    ['recipient 22', 8, 22],
    ['recipient 24', 8, 24],
    ['recipient 26', 8, 26],
    ['recipient 34', 8, 34],
    ['recipient 36', 8, 36],
  ] as const)('rejects %s bytes', (_name, field, length) => {
    expect(decodeFailure(replaceField(field, pushOf(length)))).toBe('field_length');
  });

  it('rejects a small-integer opcode in place of a multi-byte field', () => {
    for (const field of [3, 4, 5, 6, 7, 8]) {
      expect(decodeFailure(replaceField(field, Uint8Array.of(0x51)))).toBe('field_length');
    }
  });
});

describe('adversarial record codec: decoded-but-invalid records are caught by validateOrderParams', () => {
  it('a 25-byte recipient that is not P2PKH', () => {
    expect(validationFailure(replaceField(8, pushOf(25, 0x76)))).toBe('recipient_template');
  });

  it('a 35-byte P2PK recipient (same length as P2SH32)', () => {
    const p2pk = Uint8Array.from([0x21, 0x02, ...new Uint8Array(32).fill(0x33), 0xac]);
    expect(p2pk.length).toBe(P2SH32_RECIPIENT.length);
    const record = encodeOrderRecord({ ...PARAMS, recipientLockingBytecode: p2pk });
    expect(validationFailure(record)).toBe('recipient_template');
  });

  it('minOut of 2^64 - 1 (above int64)', () => {
    expect(validationFailure(replaceField(5, pushOf(8, 0xff)))).toBe('min_out_range');
  });

  it('minOut of 0', () => {
    expect(validationFailure(replaceField(5, pushOf(8, 0x00)))).toBe('min_out_range');
  });

  it('maxNetworkFee of 0 and of 2^64 - 1', () => {
    expect(validationFailure(replaceField(6, pushOf(8, 0x00)))).toBe('max_network_fee_range');
    expect(validationFailure(replaceField(6, pushOf(8, 0xff)))).toBe('max_network_fee_range');
  });

  it('an all-zero nonce', () => {
    expect(validationFailure(replaceField(7, pushOf(8, 0x00)))).toBe('nonce_zero');
  });

  it('a category that is not on the allowlist', () => {
    expect(validationFailure(replaceField(4, pushOf(32, 0x42)))).toBe('token_category_unsupported');
  });

  it('a category whose VM-order bytes equal the allowlisted display-order bytes (byte-order confusion)', () => {
    const displayBytes = Uint8Array.from(CATEGORY.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
    expect(validationFailure(replaceField(4, flattenBinArray([Uint8Array.of(32), displayBytes])))).toBe(
      'token_category_unsupported',
    );
  });
});
