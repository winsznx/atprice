import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, marketsSchema, unsignedAmount } from '../src/index.js';

describe('api schemas', () => {
  it('parses decimal amounts to bigint and rejects non-canonical ones', () => {
    expect(unsignedAmount.parse('12345678901234567890')).toBe(12345678901234567890n);
    expect(unsignedAmount.safeParse('012').success).toBe(false);
  });

  it('rejects a market without the fields the web reads', () => {
    expect(marketsSchema.safeParse({ markets: [{ tokenId: 'ab'.repeat(32) }] }).success).toBe(false);
  });

  it('accepts the server error envelope', () => {
    expect(errorEnvelopeSchema.parse({ error: 'order_not_found', message: 'no order' }).error).toBe(
      'order_not_found',
    );
  });
});
