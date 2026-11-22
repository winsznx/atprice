import { describe, expect, it } from 'vitest';
import { topUpRequest } from './cancel-rules';

describe('topUpRequest', () => {
  it('asks for at least 1,500 sat and never less than the builder needs', () => {
    expect(topUpRequest(546n)).toBe(1_500n);
    expect(topUpRequest(2_100n)).toBe(2_100n);
  });
});
