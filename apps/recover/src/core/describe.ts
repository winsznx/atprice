import { SELL_ORDER_SATS, sellNetProceedsFromMinOut, type Network } from '@atprice/core';
import { binToHex, encodeCashAddress, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { formatBch, formatFee, formatSats, formatSignedUnits, formatToken } from '../../../web/lib/format';
import { CASH_ADDRESS_PREFIX } from '../config';
import type { HeldValue, LoadedOrder, OrderChainStatus } from './lookup';

/** Every amount in Recover is DD 4 `exact` mode. */
const EXACT = 'exact';

export const bchText = (sats: bigint): string => `${formatBch(sats, EXACT)} BCH`;

export const feeText = (sats: bigint): string => formatFee(sats, EXACT);

/** A token amount with its allowlisted symbol, or base units with no symbol for a category not on the list. */
export const tokenText = (order: LoadedOrder, units: bigint): string =>
  order.market === undefined
    ? `${formatToken(units, 0, EXACT)} base units`
    : `${formatToken(units, order.market.decimals, EXACT)} ${order.market.symbol}`;

export const tokenLabel = (order: LoadedOrder): string => order.market?.symbol ?? 'unlisted token';

export const sideLabel = (order: LoadedOrder): string => (order.record.side === 'buy' ? 'Buy' : 'Sell');

/** Lines of what a held value is worth: tokens first, then BCH. */
export const heldLines = (order: LoadedOrder, value: HeldValue): string[] => {
  const lines: string[] = [];
  if (value.token !== undefined) {
    lines.push(
      value.token.category === order.record.tokenCategory
        ? tokenText(order, value.token.amount)
        : `${formatToken(value.token.amount, 0, EXACT)} base units of token ${value.token.category}`,
    );
  }
  lines.push(bchText(value.satoshis));
  return lines;
};

export type MinimumLine =
  | { readonly kind: 'buy'; readonly text: string }
  | { readonly kind: 'sell'; readonly text: string; readonly payoutLine: string }
  | { readonly kind: 'none'; readonly text: string };

/**
 * DD 4.1: the user's minimum, never the raw sell `minOut`. A sell at or below the reserve (made by
 * another tool) has no minimum price, said in so many words.
 */
export const minimumLine = (order: LoadedOrder): MinimumLine => {
  const { side, minOut } = order.record;
  if (side === 'buy') return { kind: 'buy', text: tokenText(order, minOut) };
  if (minOut <= SELL_ORDER_SATS) {
    return {
      kind: 'none',
      text: `No minimum price: the contract value ${formatSats(minOut)} sat does not exceed the 2,000 sat reserve.`,
    };
  }
  return {
    kind: 'sell',
    text: bchText(sellNetProceedsFromMinOut(minOut)),
    payoutLine: `Paid in one output of at least ${bchText(minOut)}: your proceeds plus the 2,000 sat reserve you locked. The network fee comes out of the pool's BCH, not out of this.`,
  };
};

/** `Above your minimum` on a fill (DD 4.1): buy `received - minOut` tokens, sell `payout - minOut` sat. */
export const aboveMinimumText = (order: LoadedOrder, delivered: bigint): string => {
  const surplus = delivered - order.record.minOut;
  if (order.record.side === 'sell') return `${formatSignedUnits(surplus, 8, EXACT)} BCH`;
  return order.market === undefined
    ? `${formatSignedUnits(surplus, 0, EXACT)} base units`
    : `${formatSignedUnits(surplus, order.market.decimals, EXACT)} ${order.market.symbol}`;
};

export const ownerAddressOf = (ownerPkh: Uint8Array, network: Network): string =>
  encodeCashAddress({ prefix: CASH_ADDRESS_PREFIX[network], type: 'p2pkh', payload: ownerPkh }).address;

/** The recipient as an address: token-aware for a buy (it receives tokens), plain for a sell. */
export const recipientAddressOf = (order: LoadedOrder): string => {
  const result = lockingBytecodeToCashAddress({
    bytecode: order.record.recipientLockingBytecode,
    prefix: CASH_ADDRESS_PREFIX[order.network],
    tokenSupport: order.record.side === 'buy',
  });
  return typeof result === 'string' ? binToHex(order.record.recipientLockingBytecode) : result.address;
};

/** The address a person pays to fund or look at this contract: the token address for a sell. */
export const contractAddressOf = (order: LoadedOrder): string =>
  order.record.side === 'sell' ? order.tokenAddress : order.address;

/** A key hash read in groups of four, so it can be compared by ear (recover.md "Screen-reader labels"). */
export const spokenGroups = (hex: string): string => hex.replace(/(.{4})(?=.)/g, '$1 ');

export const STATUS_BADGE: Readonly<Record<OrderChainStatus['kind'], string>> = {
  unspent: 'Unspent: can cancel',
  filled: 'Filled',
  cancelled: 'Cancelled',
  needs_review: 'Needs review',
};

export interface ParameterRow {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
}

/** Every decoded field for the `Parameters` view; the raw `minOut` appears only here, labelled. */
export const parameterRows = (order: LoadedOrder): ParameterRow[] => {
  const { record } = order;
  return [
    { label: 'Record version', value: String(record.version), mono: false },
    { label: 'Side', value: record.side, mono: false },
    { label: 'Owner key hash (ownerPkh)', value: binToHex(record.ownerPkh), mono: true },
    { label: 'Recipient locking bytecode', value: binToHex(record.recipientLockingBytecode), mono: true },
    { label: 'Token category', value: record.tokenCategory, mono: true },
    {
      label: 'minOut (contract value; for a sell this includes the 2,000 sat reserve)',
      value:
        record.side === 'buy'
          ? `${tokenText(order, record.minOut)} (${formatSats(record.minOut)} base units)`
          : `${bchText(record.minOut)} (${formatSats(record.minOut)} sat)`,
      mono: false,
    },
    { label: 'maxNetworkFee (fee cap)', value: feeText(record.maxNetworkFee), mono: false },
    { label: 'Nonce', value: binToHex(record.nonce), mono: true },
    { label: 'OP_RETURN record (hex)', value: order.recordHex, mono: true },
  ];
};

/** `Copy parameters (JSON)`: everything needed to rebuild and cancel this order by hand. */
export const parametersJson = (order: LoadedOrder): string => {
  const { record, fundingOutput } = order;
  return JSON.stringify(
    {
      network: order.network,
      contractVersion: record.version,
      contract: record.side === 'buy' ? 'AtPriceBuy' : 'AtPriceSell',
      constructorParameters: {
        ownerPkh: binToHex(record.ownerPkh),
        recipientLockingBytecode: binToHex(record.recipientLockingBytecode),
        tokenCategory: record.tokenCategory,
        minOut: record.minOut.toString(),
        minOutNote: 'contract value; for a sell this includes the 2,000 sat reserve',
        maxNetworkFee: record.maxNetworkFee.toString(),
        nonce: binToHex(record.nonce),
      },
      contractAddress: contractAddressOf(order),
      contractLockingBytecode: binToHex(order.lockingBytecode),
      funding: {
        outpoint: `${order.funding.txid}:${order.funding.vout}`,
        valueSatoshis: fundingOutput.satoshis.toString(),
        value: bchText(fundingOutput.satoshis),
        token:
          fundingOutput.token === undefined
            ? null
            : {
                category: fundingOutput.token.category,
                amount: fundingOutput.token.amount.toString(),
                nft: fundingOutput.token.nft ?? null,
              },
      },
      record: order.recordHex,
    },
    null,
    2,
  );
};
