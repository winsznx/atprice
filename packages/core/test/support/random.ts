/** Deterministic 64-bit generator (SplitMix64) so property-test failures reproduce from the seed. */
export class Random {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = BigInt.asUintN(64, seed);
  }

  next64(): bigint {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  }

  /** Uniform integer in `[min, max]`. */
  between(min: bigint, max: bigint): bigint {
    const span = max - min + 1n;
    let value = 0n;
    for (let bits = 0n; 1n << bits < span * 2n ** 64n; bits += 64n) value = (value << 64n) | this.next64();
    return min + (value % span);
  }

  /** Integer whose magnitude is spread across `[1, 2^maxBits]` on a log scale. */
  logScale(minBits: number, maxBits: number): bigint {
    const bits = this.between(BigInt(minBits), BigInt(maxBits));
    return this.between(2n ** (bits - 1n), 2n ** bits);
  }

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => Number(this.next64() & 0xffn));
  }
}
