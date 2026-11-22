import { binToHex, encodeLockingBytecodeP2pkh, type Output, type TransactionCommon } from '@bitauth/libauth';
import { bytesEqual } from './bytes.js';
import {
  InvalidOrderParamsError,
  RecordDecodeError,
  type OrderParamsViolation,
  type RecordDecodeFailure,
} from './errors.js';
import {
  orderAmountFromFunding,
  orderLockingBytecode,
  validateOrderParams,
  type ObservedOrderOutput,
  type OrderParams,
  type OrderSide,
} from './order.js';
import { decodeOrderRecord } from './record.js';

/** One entry of a network's supported-market allowlist, as far as order support needs it. */
export interface SupportedMarket {
  /** Display-order category ID. */
  readonly tokenCategory: string;
  /** Market minimum per side: satoshis to spend for a buy, token units for a sell. */
  readonly minimumAmount: Readonly<Record<OrderSide, bigint>>;
}

export interface MarketDomain {
  readonly markets: readonly SupportedMarket[];
}

export type FundingShapeViolation =
  | 'record_missing'
  | 'record_multiple'
  | 'order_output_missing'
  | 'order_output_multiple'
  | 'unexpected_output';

/** Why an order instance is stored with `supported = false` (cancel only). */
export type UnsupportedReason = OrderParamsViolation | RecordDecodeFailure | FundingShapeViolation;

export interface Unsupported {
  readonly supported: false;
  readonly reason: UnsupportedReason;
  readonly detail: string;
}

export type OrderInstanceSupport = { readonly supported: true; readonly amount: bigint } | Unsupported;

/**
 * On failure, `params` is present whenever the record decoded and `fundingVout` whenever exactly one
 * output pays the order address, so the indexer can still track the order as cancel-only.
 */
export type FundingSupport =
  | {
      readonly supported: true;
      readonly params: OrderParams;
      readonly fundingVout: number;
      readonly amount: bigint;
    }
  | (Unsupported & { readonly params?: OrderParams; readonly fundingVout?: number });

const OP_RETURN = 0x6a;

const unsupported = (reason: UnsupportedReason, detail: string): Unsupported => ({
  supported: false,
  reason,
  detail,
});

const fromError = (error: unknown): Unsupported => {
  if (error instanceof InvalidOrderParamsError || error instanceof RecordDecodeError) {
    return unsupported(error.reason, error.message);
  }
  throw error;
};

const observed = (output: Output): ObservedOrderOutput => ({
  satoshis: output.valueSatoshis,
  ...(output.token && {
    token: {
      category: binToHex(output.token.category),
      amount: output.token.amount,
      ...(output.token.nft && { nft: output.token.nft }),
    },
  }),
});

/**
 * The shared per-instance check (architecture.md, validation of on-chain orders). Decides
 * `supported` for any UTXO at an order address: the funding output itself and every other UTXO that
 * lands there later. Supported means the order params pass every domain rule including the
 * allowlist, and the UTXO is exactly what `orderFunding` prescribes for an amount at or above
 * the market minimum: a token-free buy of `spend + 1000 + maxNetworkFee`, or a 2000-sat sell
 * holding a non-zero fungible amount of the market token and no NFT.
 */
export const assessOrderInstance = (
  params: OrderParams,
  output: ObservedOrderOutput,
  domain: MarketDomain,
): OrderInstanceSupport => {
  try {
    validateOrderParams(params, { supportedTokenCategories: domain.markets.map((m) => m.tokenCategory) });
    const market = domain.markets.find((m) => m.tokenCategory === params.tokenCategory);
    if (market === undefined) {
      return unsupported(
        'token_category_unsupported',
        `token ${params.tokenCategory} is not a supported market`,
      );
    }
    return {
      supported: true,
      amount: orderAmountFromFunding(params, output, market.minimumAmount[params.side]),
    };
  } catch (error) {
    return fromError(error);
  }
};

/**
 * Decides whether a funding transaction creates a supported order. Exactly one OP_RETURN output,
 * holding a valid ATPR record; exactly one output paying the covenant re-derived from it
 * (`fundingVout`); every other output pays `P2PKH(ownerPkh)`, at most one of them token-free (owner
 * change) and at most one, on a sell only, holding a fungible amount of the market token and no NFT
 * (owner token change, funding output 3); and the order output passes {@link assessOrderInstance}.
 */
export const assessFunding = (transaction: TransactionCommon, domain: MarketDomain): FundingSupport => {
  const records = transaction.outputs.filter((output) => output.lockingBytecode[0] === OP_RETURN);
  const [recordOutput] = records;
  if (recordOutput === undefined) return unsupported('record_missing', 'no OP_RETURN output');
  if (records.length > 1) return unsupported('record_multiple', `${records.length} OP_RETURN outputs`);
  let params: OrderParams;
  try {
    const record = decodeOrderRecord(recordOutput.lockingBytecode);
    params = {
      side: record.side,
      ownerPkh: record.ownerPkh,
      recipientLockingBytecode: record.recipientLockingBytecode,
      tokenCategory: record.tokenCategory,
      minOut: record.minOut,
      maxNetworkFee: record.maxNetworkFee,
      nonce: record.nonce,
    };
  } catch (error) {
    return fromError(error);
  }

  const orderLocking = orderLockingBytecode(params);
  const orderVouts = transaction.outputs.flatMap((output, vout) =>
    bytesEqual(output.lockingBytecode, orderLocking) ? [vout] : [],
  );
  const [fundingVout] = orderVouts;
  if (fundingVout === undefined) {
    return { ...unsupported('order_output_missing', 'no output pays the re-derived order address'), params };
  }
  if (orderVouts.length > 1) {
    return {
      ...unsupported('order_output_multiple', `outputs ${orderVouts.join(', ')} pay the order address`),
      params,
    };
  }

  const ownerLocking = encodeLockingBytecodeP2pkh(params.ownerPkh);
  let ownerChange = 0;
  let ownerTokenChange = 0;
  for (const [vout, output] of transaction.outputs.entries()) {
    if (vout === fundingVout || output === recordOutput) continue;
    const unexpected = (why: string): FundingSupport => ({
      ...unsupported('unexpected_output', `output ${vout} ${why}`),
      params,
      fundingVout,
    });
    if (!bytesEqual(output.lockingBytecode, ownerLocking)) return unexpected('does not pay the owner');
    if (output.token === undefined) {
      ownerChange += 1;
      if (ownerChange > 1) return unexpected('is a second token-free owner output');
      continue;
    }
    ownerTokenChange += 1;
    if (ownerTokenChange > 1) return unexpected('is a second owner token output');
    if (params.side !== 'sell') return unexpected('returns tokens from a buy funding');
    if (binToHex(output.token.category) !== params.tokenCategory || output.token.nft !== undefined) {
      return unexpected('holds tokens other than the market token change');
    }
  }

  const fundingOutput = transaction.outputs[fundingVout];
  if (fundingOutput === undefined) throw new RangeError(`funding output ${fundingVout} vanished`);
  const instance = assessOrderInstance(params, observed(fundingOutput), domain);
  return instance.supported
    ? { supported: true, params, fundingVout, amount: instance.amount }
    : { ...instance, params, fundingVout };
};
