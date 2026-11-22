import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import {
  DEFAULT_MAX_NETWORK_FEE,
  encodeOrderRecord,
  InvalidOrderParamsError,
  orderAddresses,
  ownerLockingBytecode,
  recipientLockingBytecodeFromAddress,
  supportedTokenCategories,
  validateOrderParams,
  bytesEqual,
  type AtPriceError,
  type Network,
  type OrderParams,
  type OrderSide,
} from '@atprice/core';
import type { IntentRequest } from '@/lib/api/client';
import type { NetworkConfig } from '@/lib/network';

/*
 * DD 7.2 steps a to c: every order parameter is derived in the browser with `@atprice/core` and the
 * artifacts bundled in the build. The server's intent answer is only ever compared with these values,
 * never used as a source of terms (architecture.md "Order creation").
 */

/** `maxNetworkFee` comes from network config in `@atprice/core` (architecture.md step 1), never a literal. */
export const MAX_NETWORK_FEE = DEFAULT_MAX_NETWORK_FEE;

const NONCE_BYTES = 8;

/** 8 random bytes from `crypto.getRandomValues`, redrawn in the 2^-64 case that they are all zero. */
export const newNonce = (
  random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
): Uint8Array => {
  for (;;) {
    const nonce = random(new Uint8Array(NONCE_BYTES));
    if (nonce.some((byte) => byte !== 0)) return nonce;
  }
};

export type RecipientParse =
  | { readonly kind: 'ok'; readonly lockingBytecode: Uint8Array }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * The recipient field (trade.md "Controls"). Core decides network and template; a buy additionally
 * needs a token-aware address, because tokens sent to a wallet without CashTokens support can be lost.
 */
export const parseRecipient = (text: string, side: OrderSide, config: NetworkConfig): RecipientParse => {
  const address = text.trim();
  if (address === '') return { kind: 'invalid', message: 'Enter a Bitcoin Cash address.' };
  let lockingBytecode: Uint8Array;
  try {
    lockingBytecode = recipientLockingBytecodeFromAddress(address, config.network);
  } catch (error) {
    if (!(error instanceof InvalidOrderParamsError)) throw error;
    if (error.reason === 'recipient_network') {
      const decoded = cashAddressToLockingBytecode(address);
      const other =
        typeof decoded !== 'string' && decoded.prefix === 'bitcoincash' ? 'mainnet' : 'a test network';
      return { kind: 'invalid', message: `This address is for ${other}.` };
    }
    if (error.reason === 'recipient_template') {
      return { kind: 'invalid', message: 'Orders can pay only P2PKH or P2SH addresses.' };
    }
    return { kind: 'invalid', message: 'Enter a Bitcoin Cash address.' };
  }
  if (side === 'buy') {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string' || !decoded.tokenSupport) {
      return {
        kind: 'invalid',
        message: `Tokens need a CashTokens-ready address (starts with ${config.cashAddressPrefix}:z). Sending tokens to other addresses can lose them.`,
      };
    }
  }
  return { kind: 'ok', lockingBytecode };
};

export interface OrderInputs {
  readonly side: OrderSide;
  readonly tokenCategory: string;
  /** Buy: satoshis to spend. Sell: token units to sell. */
  readonly amount: bigint;
  readonly minOut: bigint;
  readonly ownerPkh: Uint8Array;
  /** Null means the owner's own address (the default recipient). */
  readonly recipientLockingBytecode: Uint8Array | null;
}

export interface DerivedOrder {
  readonly params: OrderParams;
  readonly amount: bigint;
  /** P2SH32 address the order is funded to: the token-aware form for a sell. */
  readonly orderAddress: string;
  readonly orderLockingBytecode: Uint8Array;
  readonly record: Uint8Array;
}

/** Steps a to c: parameters, `validateOrderParams` against this network's allowlist, address, record. */
export const deriveOrder = (
  inputs: OrderInputs,
  network: Network,
  nonce: Uint8Array = newNonce(),
): DerivedOrder => {
  const params: OrderParams = {
    side: inputs.side,
    ownerPkh: inputs.ownerPkh,
    recipientLockingBytecode: inputs.recipientLockingBytecode ?? ownerLockingBytecode(inputs.ownerPkh),
    tokenCategory: inputs.tokenCategory,
    minOut: inputs.minOut,
    maxNetworkFee: MAX_NETWORK_FEE,
    nonce,
  };
  validateOrderParams(params, { supportedTokenCategories: supportedTokenCategories(network) });
  const addresses = orderAddresses(params, network);
  return {
    params,
    amount: inputs.amount,
    orderAddress: params.side === 'sell' ? addresses.tokenAddress : addresses.address,
    orderLockingBytecode: addresses.lockingBytecode,
    record: encodeOrderRecord(params),
  };
};

/** The parameters `POST /orders/intents` takes, hex and bigint. */
export const intentRequest = (order: DerivedOrder): IntentRequest => ({
  side: order.params.side,
  ownerPkh: binToHex(order.params.ownerPkh),
  recipientLockingBytecode: binToHex(order.params.recipientLockingBytecode),
  tokenCategory: order.params.tokenCategory,
  amount: order.amount,
  minOut: order.params.minOut,
  maxNetworkFee: order.params.maxNetworkFee,
  nonce: binToHex(order.params.nonce),
});

/**
 * DD 7.2 step d: the server's address matches when it encodes the same locking bytecode, whichever
 * of the plain or token-aware forms it chose to send.
 */
export const intentAddressMatches = (serverAddress: string, order: DerivedOrder): boolean => {
  const decoded = cashAddressToLockingBytecode(serverAddress);
  return typeof decoded !== 'string' && bytesEqual(decoded.bytecode, order.orderLockingBytecode);
};

/** A core rejection as the code a screen prints (`AMOUNT_BELOW_MINIMUM`-style, from core's reason). */
export const coreErrorCode = (error: AtPriceError): string => error.reason.toUpperCase();
