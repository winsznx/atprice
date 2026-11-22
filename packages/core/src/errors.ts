/** Base class for every error raised by `@atprice/core`. `reason` is a stable machine-readable code. */
export abstract class AtPriceError<TReason extends string = string> extends Error {
  readonly reason: TReason;

  constructor(reason: TReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = new.target.name;
  }
}

export type OrderParamsViolation =
  | 'owner_public_key_invalid'
  | 'owner_pkh_length'
  | 'recipient_template'
  | 'recipient_address'
  | 'recipient_network'
  | 'token_category_format'
  | 'token_category_unsupported'
  | 'min_out_range'
  | 'max_network_fee_range'
  | 'nonce_length'
  | 'nonce_zero'
  | 'amount_range'
  | 'amount_below_minimum'
  | 'funding_mismatch'
  | 'limit_price_invalid';

/** A value is outside the domain the contract spec allows for an order. */
export class InvalidOrderParamsError extends AtPriceError<OrderParamsViolation> {}

export type RecordDecodeFailure =
  | 'not_op_return'
  | 'malformed_push'
  | 'non_minimal_push'
  | 'missing_field'
  | 'bad_magic'
  | 'unsupported_version'
  | 'invalid_side'
  | 'field_length'
  | 'trailing_bytes';

/** An OP_RETURN output is not a well-formed AtPrice funding record. */
export class RecordDecodeError extends AtPriceError<RecordDecodeFailure> {}

export type PoolViolation =
  'owner_pkh_length' | 'not_cauldron_v0' | 'token_mismatch' | 'nft_present' | 'empty_reserves';

/** A UTXO offered as a Cauldron pool is not a usable Cauldron V0 pool for the order. */
export class InvalidPoolError extends AtPriceError<PoolViolation> {}

export type QuoteFailure = 'non_positive_input' | 'invalid_reserves';

/** A quote cannot be computed for the given pool and amount. */
export class QuoteError extends AtPriceError<QuoteFailure> {}

export type NotExecutableReason =
  'below_min_out' | 'fee_above_cap' | 'order_value_too_small' | 'order_token_mismatch' | 'pool_below_dust';

/** The order cannot be filled against this pool right now (a normal keeper outcome, not a defect). */
export class OrderNotExecutableError extends AtPriceError<NotExecutableReason> {}

export type TransactionBuildFailure =
  | 'no_orders'
  | 'owner_mismatch'
  | 'owner_utxo_invalid'
  | 'fee_exceeds_allowance'
  | 'fee_did_not_converge'
  | 'wallet_utxo_invalid';

/** A transaction cannot be assembled from the inputs given. */
export class TransactionBuildError extends AtPriceError<TransactionBuildFailure> {}

export type TokenBurnFailure = 'fungible_mismatch' | 'nft_mismatch';

/**
 * A transaction about to go to the wallet would not carry every token of its inputs to its outputs
 * unchanged (architecture.md, order creation step 5). Always a builder defect or a tampered draft.
 */
export class TokenBurnRefused extends AtPriceError<TokenBurnFailure> {
  readonly category: string;

  constructor(reason: TokenBurnFailure, category: string, message: string) {
    super(reason, message);
    this.category = category;
  }
}

export type OwnerUtxoShortfall = 'owner_address_empty' | 'owner_utxo_too_small';

/**
 * `cancel()` needs one token-free UTXO at `P2PKH(ownerPkh)` worth at least `requiredSatoshis`.
 * `owner_address_empty`: the owner address holds no token-free UTXO at all. `owner_utxo_too_small`:
 * none of them is large enough. Either way the user sends one payment of at least
 * `requiredSatoshis` to the owner address and the cancel is built again.
 */
export class OwnerUtxoRequiredError extends AtPriceError<OwnerUtxoShortfall> {
  readonly requiredSatoshis: bigint;
  /** The largest token-free owner UTXO offered, 0 when there is none. */
  readonly largestSatoshis: bigint;

  constructor(reason: OwnerUtxoShortfall, requiredSatoshis: bigint, largestSatoshis: bigint) {
    super(
      reason,
      reason === 'owner_address_empty'
        ? `the owner address holds no token-free UTXO; send at least ${requiredSatoshis} sats to it`
        : `the largest token-free owner UTXO holds ${largestSatoshis} sats; send at least ${requiredSatoshis} sats to the owner address in one payment`,
    );
    this.requiredSatoshis = requiredSatoshis;
    this.largestSatoshis = largestSatoshis;
  }
}

/** The wallet UTXOs cannot cover what the transaction needs. */
export class InsufficientFundsError extends AtPriceError<'insufficient_bch' | 'insufficient_tokens'> {
  readonly required: bigint;
  readonly available: bigint;

  constructor(reason: 'insufficient_bch' | 'insufficient_tokens', required: bigint, available: bigint) {
    super(
      reason,
      `${reason === 'insufficient_bch' ? 'BCH' : 'token'} needed ${required}, available ${available}`,
    );
    this.required = required;
    this.available = available;
  }
}

export type VerificationFailure =
  | 'decode_failed'
  | 'source_output_count'
  | 'vm_rejected'
  | 'fee_below_relay_minimum'
  | 'wallet_changed_transaction';

/** A transaction failed local verification (BCH_2026_05 VM in standard mode, plus relay fee rules). */
export class TransactionVerificationError extends AtPriceError<VerificationFailure> {}
