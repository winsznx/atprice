import { AtPriceBuyArtifact, AtPriceSellArtifact } from '@atprice/contracts';
import {
  cashAddressToLockingBytecode,
  encodeLockingBytecodeP2pkh,
  encodeLockingBytecodeP2sh32,
  hash160,
  hash256,
  isPayToPublicKeyHash,
  isPayToScriptHash20,
  isPayToScriptHash32,
  lockingBytecodeToCashAddress,
  secp256k1,
} from '@bitauth/libauth';
import { Contract, encodeFunctionArgument, utils, type NetworkProvider } from 'cashscript';
import { isTokenCategoryHex, tokenCategoryToVmBytes } from './bytes.js';
import {
  BUY_PAYOUT_SATS,
  MAX_INT64,
  MAX_NETWORK_FEE_CEILING,
  MAX_NETWORK_FEE_FLOOR,
  SELL_ORDER_SATS,
} from './constants.js';
import { InvalidOrderParamsError, type OrderParamsViolation } from './errors.js';

export type Network = 'mainnet' | 'chipnet';
export type OrderSide = 'buy' | 'sell';

/** Everything that defines an order covenant (the constructor arguments plus the side). */
export interface OrderParams {
  readonly side: OrderSide;
  /** hash160 of the owner's compressed public key (wallet `receive/0`). */
  readonly ownerPkh: Uint8Array;
  /** P2PKH, P2SH20 or P2SH32 locking bytecode that receives the fill. */
  readonly recipientLockingBytecode: Uint8Array;
  /** Category ID in display order, as explorers and the Cauldron indexer show it. */
  readonly tokenCategory: string;
  /** Buy: minimum token units. Sell: minimum gross payout in satoshis (net proceeds + 2000). */
  readonly minOut: bigint;
  readonly maxNetworkFee: bigint;
  /** 8 random bytes, never all zero. */
  readonly nonce: Uint8Array;
}

/** Domain facts that live outside the order itself (the network's supported-market allowlist). */
export interface OrderDomain {
  readonly supportedTokenCategories: readonly string[];
}

export type RecipientType = 'p2pkh' | 'p2sh20' | 'p2sh32';

export const recipientType = (lockingBytecode: Uint8Array): RecipientType | undefined => {
  if (isPayToPublicKeyHash(lockingBytecode)) return 'p2pkh';
  if (isPayToScriptHash20(lockingBytecode)) return 'p2sh20';
  if (isPayToScriptHash32(lockingBytecode)) return 'p2sh32';
  return undefined;
};

const COMPRESSED_PUBLIC_KEY_LENGTH = 33;

/** hash160 of a compressed secp256k1 public key, after checking the point is on the curve. */
export const ownerPkhFromPublicKey = (publicKey: Uint8Array): Uint8Array => {
  const prefix = publicKey[0];
  const compressed =
    publicKey.length === COMPRESSED_PUBLIC_KEY_LENGTH && (prefix === 0x02 || prefix === 0x03);
  if (!compressed || !secp256k1.validatePublicKey(publicKey)) {
    throw new InvalidOrderParamsError(
      'owner_public_key_invalid',
      'owner key must be a valid compressed public key',
    );
  }
  return hash160(publicKey);
};

/** The default recipient: the owner's own P2PKH. */
export const ownerLockingBytecode = (ownerPkh: Uint8Array): Uint8Array => {
  if (ownerPkh.length !== 20) {
    throw new InvalidOrderParamsError(
      'owner_pkh_length',
      `ownerPkh must be 20 bytes, got ${ownerPkh.length}`,
    );
  }
  return encodeLockingBytecodeP2pkh(ownerPkh);
};

const CASH_ADDRESS_PREFIX: Record<Network, 'bitcoincash' | 'bchtest'> = {
  mainnet: 'bitcoincash',
  chipnet: 'bchtest',
};

/** Locking bytecode of a user-entered recipient address, restricted to the order's network and templates. */
export const recipientLockingBytecodeFromAddress = (address: string, network: Network): Uint8Array => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') {
    throw new InvalidOrderParamsError('recipient_address', `not a valid cash address: ${decoded}`);
  }
  if (decoded.prefix !== CASH_ADDRESS_PREFIX[network]) {
    throw new InvalidOrderParamsError(
      'recipient_network',
      `address is for ${decoded.prefix}, not ${network}`,
    );
  }
  if (recipientType(decoded.bytecode) === undefined) {
    throw new InvalidOrderParamsError('recipient_template', 'recipient must be P2PKH, P2SH20 or P2SH32');
  }
  return decoded.bytecode;
};

/** Smallest `minOut` per side: a sell payout must exceed the order's own 2000 sats (P >= 1). */
export const minimumMinOut = (side: OrderSide): bigint => (side === 'buy' ? 1n : SELL_ORDER_SATS + 1n);

const fail = (reason: OrderParamsViolation, message: string): never => {
  throw new InvalidOrderParamsError(reason, message);
};

/**
 * Throws {@link InvalidOrderParamsError} unless every domain rule of the contract spec that the
 * order can be checked against on its own holds: everything except the supported-market allowlist.
 * {@link buildFundingTransaction} runs it, so no out-of-domain covenant is ever funded.
 */
export const validateOrderShape = (params: OrderParams): void => {
  if (params.ownerPkh.length !== 20)
    fail('owner_pkh_length', `ownerPkh must be 20 bytes, got ${params.ownerPkh.length}`);
  if (recipientType(params.recipientLockingBytecode) === undefined) {
    fail('recipient_template', 'recipient must be P2PKH, P2SH20 or P2SH32');
  }
  if (!isTokenCategoryHex(params.tokenCategory)) {
    fail('token_category_format', 'token category must be 64 lowercase hex characters');
  }
  const minOutFloor = minimumMinOut(params.side);
  if (params.minOut < minOutFloor || params.minOut > MAX_INT64) {
    fail(
      'min_out_range',
      `${params.side} minOut must be between ${minOutFloor} and ${MAX_INT64}, got ${params.minOut}`,
    );
  }
  if (params.maxNetworkFee < MAX_NETWORK_FEE_FLOOR || params.maxNetworkFee > MAX_NETWORK_FEE_CEILING) {
    fail(
      'max_network_fee_range',
      `maxNetworkFee must be between ${MAX_NETWORK_FEE_FLOOR} and ${MAX_NETWORK_FEE_CEILING}, got ${params.maxNetworkFee}`,
    );
  }
  if (params.nonce.length !== 8) fail('nonce_length', `nonce must be 8 bytes, got ${params.nonce.length}`);
  if (params.nonce.every((byte) => byte === 0)) fail('nonce_zero', 'nonce must not be all zero');
};

/** Throws {@link InvalidOrderParamsError} unless every domain rule of the contract spec holds. */
export const validateOrderParams = (params: OrderParams, domain: OrderDomain): void => {
  validateOrderShape(params);
  if (!domain.supportedTokenCategories.includes(params.tokenCategory)) {
    fail('token_category_unsupported', `token ${params.tokenCategory} is not a supported market`);
  }
};

/** What the order output of a funding transaction must hold. */
export interface OrderFunding {
  readonly satoshis: bigint;
  /** Token units; 0 for a buy. */
  readonly tokenAmount: bigint;
}

/**
 * Funding for an order of `amount` (buy: satoshis to spend in the pool; sell: token units).
 * Buy `V = spend + 1000 + maxNetworkFee`; sell `V = 2000` sats plus the tokens.
 */
export const orderFunding = (
  params: Pick<OrderParams, 'side' | 'maxNetworkFee'>,
  amount: bigint,
  minimumAmount: bigint,
): OrderFunding => {
  if (amount <= 0n || amount > MAX_INT64) {
    throw new InvalidOrderParamsError(
      'amount_range',
      `order amount must be between 1 and ${MAX_INT64}, got ${amount}`,
    );
  }
  if (amount < minimumAmount) {
    throw new InvalidOrderParamsError(
      'amount_below_minimum',
      `order amount ${amount} is below the market minimum ${minimumAmount}`,
    );
  }
  return params.side === 'buy'
    ? { satoshis: amount + BUY_PAYOUT_SATS + params.maxNetworkFee, tokenAmount: 0n }
    : { satoshis: SELL_ORDER_SATS, tokenAmount: amount };
};

/** A UTXO as the indexer observes it at an order address. */
export interface ObservedOrderOutput {
  readonly satoshis: bigint;
  readonly token?: {
    readonly category: string;
    readonly amount: bigint;
    readonly nft?: unknown;
  };
}

/**
 * Recovers the order amount from an observed funding output and checks it is exactly what
 * {@link orderFunding} prescribes. Anything else is cancel-only.
 */
export const orderAmountFromFunding = (
  params: Pick<OrderParams, 'side' | 'maxNetworkFee' | 'tokenCategory'>,
  output: ObservedOrderOutput,
  minimumAmount: bigint,
): bigint => {
  const mismatch = (message: string): never => {
    throw new InvalidOrderParamsError('funding_mismatch', message);
  };
  if (params.side === 'buy') {
    if (output.token !== undefined) mismatch('a buy order output must not hold tokens');
    const spend = output.satoshis - BUY_PAYOUT_SATS - params.maxNetworkFee;
    orderFunding(params, spend, minimumAmount);
    return spend;
  }
  const token = output.token;
  if (token === undefined) return mismatch('a sell order output must hold the market token');
  if (token.category !== params.tokenCategory) mismatch('sell order output holds another token');
  if (token.nft !== undefined) mismatch('sell order output must not hold an NFT');
  if (output.satoshis !== SELL_ORDER_SATS) mismatch(`sell order output must hold ${SELL_ORDER_SATS} sats`);
  orderFunding(params, token.amount, minimumAmount);
  return token.amount;
};

export type OrderArtifact = typeof AtPriceBuyArtifact | typeof AtPriceSellArtifact;

export const orderArtifact = (side: OrderSide): OrderArtifact =>
  side === 'buy' ? AtPriceBuyArtifact : AtPriceSellArtifact;

type OrderConstructorArgs = [Uint8Array, Uint8Array, Uint8Array, bigint, bigint, Uint8Array];

const constructorArgs = (params: OrderParams): OrderConstructorArgs => [
  params.ownerPkh,
  params.recipientLockingBytecode,
  tokenCategoryToVmBytes(params.tokenCategory),
  params.minOut,
  params.maxNetworkFee,
  params.nonce,
];

/** The covenant's redeem script, derived without a network provider. */
export const orderRedeemScript = (params: OrderParams): Uint8Array => {
  const artifact = orderArtifact(params.side);
  const args = constructorArgs(params);
  const encoded = artifact.constructorInputs.map((input, index) => {
    const value = encodeFunctionArgument(args[index] as OrderConstructorArgs[number], input.type);
    if (!(value instanceof Uint8Array))
      throw new TypeError(`constructor argument ${input.name} did not encode to bytes`);
    return value;
  });
  return utils.scriptToBytecode(
    utils.generateContractBytecodeScript(utils.asmToScript(artifact.bytecode), encoded),
  );
};

export interface OrderAddresses {
  readonly lockingBytecode: Uint8Array;
  readonly address: string;
  /** Token-aware address; sell orders are funded to this one. */
  readonly tokenAddress: string;
}

/** P2SH32 locking bytecode of the order covenant (the same on every network). */
export const orderLockingBytecode = (params: OrderParams): Uint8Array =>
  encodeLockingBytecodeP2sh32(hash256(orderRedeemScript(params)));

/** P2SH32 locking bytecode and cash addresses of the order covenant on `network`. */
export const orderAddresses = (params: OrderParams, network: Network): OrderAddresses => {
  const lockingBytecode = orderLockingBytecode(params);
  const encode = (tokenSupport: boolean): string => {
    const result = lockingBytecodeToCashAddress({
      bytecode: lockingBytecode,
      prefix: CASH_ADDRESS_PREFIX[network],
      tokenSupport,
    });
    if (typeof result === 'string') throw new TypeError(`cannot encode order address: ${result}`);
    return result.address;
  };
  return { lockingBytecode, address: encode(false), tokenAddress: encode(true) };
};

export type OrderContract = Contract<typeof AtPriceBuyArtifact> | Contract<typeof AtPriceSellArtifact>;

/** An order's parameters together with its instantiated CashScript contract. */
export interface Order {
  readonly params: OrderParams;
  readonly contract: OrderContract;
}

/** Instantiates the covenant as a P2SH32 CashScript contract. The provider performs any I/O. */
export const instantiateOrder = (params: OrderParams, provider: NetworkProvider): Order => {
  const args = constructorArgs(params);
  const contract: OrderContract =
    params.side === 'buy'
      ? new Contract(AtPriceBuyArtifact, args, { provider, contractType: 'p2sh32' })
      : new Contract(AtPriceSellArtifact, args, { provider, contractType: 'p2sh32' });
  return { params, contract };
};
