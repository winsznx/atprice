/** Satoshis on the buy payout output (contract: `tx.outputs[1].value == 1000`). */
export const BUY_PAYOUT_SATS = 1000n;
/** Satoshis a sell order UTXO holds next to its tokens. */
export const SELL_ORDER_SATS = 2000n;
/** Smallest owner output in a funding transaction (change or marker). */
export const FUNDING_MARKER_SATS = 1000n;

/** Minimum relay fee rate used everywhere in AtPrice, in satoshis per byte. */
export const MIN_RELAY_FEE_PER_BYTE = 1n;

/** Bounds of `maxNetworkFee` (contract spec, constructor table). The floor is derived in D-012. */
export const MAX_NETWORK_FEE_FLOOR = 1000n;
export const MAX_NETWORK_FEE_CEILING = 5000n;
export const DEFAULT_MAX_NETWORK_FEE = 2000n;

/**
 * Execute transaction sizes in bytes, measured from the compiled artifacts in the BCH_2026_05 VM
 * (packages/contracts/test/fee-floor.test.ts) with worst-case encodings: 9-byte token amounts on
 * pool input, pool output and payout, an 8-byte buy minOut and a 7-byte sell minOut (the largest a
 * satoshi amount can need). D-012: floor = ceil(803 * 1 sat/B * 1.2 / 100) * 100 = 1000.
 */
export const MEASURED_EXECUTE_SIZES = {
  buyP2pkh: 783,
  buyP2sh32: 803,
  sellP2pkh: 733,
  sellP2sh32: 753,
} as const;

/** Largest value a 64-bit signed field (OP_RETURN record amounts, token amounts) can carry. */
export const MAX_INT64 = 2n ** 63n - 1n;
