import { binToHex, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import {
  assessFunding,
  buildCancelTransaction,
  buildCancelWithSigTransaction,
  classifyOrderSpend,
  decodeTransactionHex,
  instantiateOrder,
  marketDomain,
  orderAddresses,
  orderLockingBytecode,
  OwnerUtxoRequiredError,
  type Order as CoreOrder,
  type OrderParams,
  type UnsignedTransactionDraft,
} from '@atprice/core';
import type { Utxo } from 'cashscript';
import { chainNetworkProvider } from '@/lib/chain/provider';
import type { ChainAccess, ChainUtxo } from '@/lib/chain/types';
import { appNetwork } from '@/lib/network';
import {
  checkCancelRules,
  refundIndex,
  type CancelPath,
  type CancelRule,
  type CancelRuleContext,
  type CoinFacts,
} from './cancel-rules';

/*
 * Everything the cancel needs comes from the chain, never from AtPrice's records
 * (cancel-confirmation.md "The transaction this dialog builds"): the funding transaction is decoded
 * locally, the contract is re-instantiated from the bundled artifact, its locking bytecode must pay
 * the order UTXO, and the owner's own coins authorize `cancel()`.
 */

export const toUtxo = (coin: ChainUtxo): Utxo => ({
  txid: coin.txid,
  vout: coin.vout,
  satoshis: coin.satoshis,
  ...(coin.token === undefined
    ? {}
    : {
        token: {
          category: coin.token.category,
          amount: coin.token.amount,
          ...(coin.token.nft === undefined ? {} : { nft: coin.token.nft }),
        },
      }),
});

const coinFacts = (utxo: Utxo): CoinFacts => ({
  txid: utxo.txid,
  vout: utxo.vout,
  satoshis: utxo.satoshis,
  ...(utxo.token === undefined
    ? {}
    : {
        token: {
          category: utxo.token.category,
          amount: utxo.token.amount,
          ...(utxo.token.nft === undefined ? {} : { nft: utxo.token.nft }),
        },
      }),
});

export interface OrderOnChain {
  readonly params: OrderParams;
  readonly order: CoreOrder;
  readonly orderUtxo: Utxo;
  readonly orderLocking: Uint8Array;
  readonly ownerLocking: Uint8Array;
}

export type OrderSpendSeen =
  | {
      readonly path: 'execute';
      readonly txid: string;
      /** Buy: token units delivered. Sell: satoshis paid to the recipient. */
      readonly delivered: bigint;
    }
  | { readonly path: 'cancel'; readonly txid: string }
  | { readonly path: 'unknown'; readonly txid: string };

export type ReadResult =
  | { readonly kind: 'ready'; readonly onChain: OrderOnChain }
  | { readonly kind: 'spent'; readonly spend: OrderSpendSeen | null }
  /** The funding transaction has no decodable `ATPR` record, or no output pays the re-derived contract. */
  | { readonly kind: 'derivation_mismatch' }
  | { readonly kind: 'not_owner' };

/** The spend of the funding outpoint, classified from the order address's history. */
export const findOrderSpend = async (
  chain: ChainAccess,
  params: OrderParams,
  funding: { readonly txid: string; readonly vout: number; readonly coin: CoinFacts },
): Promise<OrderSpendSeen | null> => {
  const history = await chain.getHistory(orderLockingBytecode(params));
  for (const entry of history) {
    if (entry.txid === funding.txid) continue;
    const transaction = decodeTransactionHex(await chain.getRawTransaction(entry.txid));
    const inputIndex = transaction.inputs.findIndex(
      (input) =>
        binToHex(input.outpointTransactionHash) === funding.txid && input.outpointIndex === funding.vout,
    );
    if (inputIndex < 0) continue;
    const spend = classifyOrderSpend(transaction, inputIndex, params, funding.coin);
    if (spend.path === 'execute') {
      return {
        path: 'execute',
        txid: entry.txid,
        delivered: params.side === 'buy' ? spend.delivered : spend.payoutSatoshis,
      };
    }
    return { path: spend.path, txid: entry.txid };
  }
  return null;
};

/** Reads the order from the chain and checks it is this owner's and still unspent. */
export const readOrderFromChain = async (
  chain: ChainAccess,
  fundingTxid: string,
  ownerPkhHex: string,
): Promise<ReadResult> => {
  const funding = decodeTransactionHex(await chain.getRawTransaction(fundingTxid));
  const assessed = assessFunding(funding, marketDomain(appNetwork.network));
  const params = assessed.params;
  const fundingVout = assessed.fundingVout;
  if (params === undefined || fundingVout === undefined) return { kind: 'derivation_mismatch' };
  if (binToHex(params.ownerPkh) !== ownerPkhHex) return { kind: 'not_owner' };

  const orderLocking = orderLockingBytecode(params);
  const fundingOutput = funding.outputs[fundingVout];
  if (fundingOutput === undefined || binToHex(fundingOutput.lockingBytecode) !== binToHex(orderLocking)) {
    return { kind: 'derivation_mismatch' };
  }
  const order = instantiateOrder(params, chainNetworkProvider(chain, appNetwork));
  if (order.contract.address !== orderAddresses(params, appNetwork.network).address) {
    return { kind: 'derivation_mismatch' };
  }

  const unspent = (await chain.getUtxos(orderLocking)).find(
    (utxo) => utxo.txid === fundingTxid && utxo.vout === fundingVout,
  );
  if (unspent === undefined) {
    const coin: CoinFacts = {
      txid: fundingTxid,
      vout: fundingVout,
      satoshis: fundingOutput.valueSatoshis,
      ...(fundingOutput.token === undefined
        ? {}
        : {
            token: {
              category: binToHex(fundingOutput.token.category),
              amount: fundingOutput.token.amount,
              ...(fundingOutput.token.nft === undefined
                ? {}
                : {
                    nft: {
                      capability: fundingOutput.token.nft.capability,
                      commitment: binToHex(fundingOutput.token.nft.commitment),
                    },
                  }),
            },
          }),
    };
    return {
      kind: 'spent',
      spend: await findOrderSpend(chain, params, { txid: fundingTxid, vout: fundingVout, coin }),
    };
  }
  return {
    kind: 'ready',
    onChain: {
      params,
      order,
      orderUtxo: toUtxo(unspent),
      orderLocking,
      ownerLocking: encodeLockingBytecodeP2pkh(params.ownerPkh),
    },
  };
};

/** Re-checks, right before signing, that the order UTXO is still unspent. */
export const orderStillUnspent = async (chain: ChainAccess, onChain: OrderOnChain): Promise<boolean> =>
  (await chain.getUtxos(onChain.orderLocking)).some(
    (utxo) => utxo.txid === onChain.orderUtxo.txid && utxo.vout === onChain.orderUtxo.vout,
  );

export interface BuiltCancel {
  readonly path: CancelPath;
  readonly draft: UnsignedTransactionDraft;
  /** The authorizing owner coin at input 0 (`cancel()` only). */
  readonly ownerCoin: Utxo | null;
  readonly refundSats: bigint;
  readonly refundTokens: bigint;
  readonly fee: bigint;
  readonly ruleContext: CancelRuleContext;
}

export class CancelBuildInvalidError extends Error {
  readonly code = 'CANCEL_BUILD_INVALID';

  constructor(
    readonly rule: CancelRule,
    readonly hex: string,
  ) {
    super(`CANCEL_BUILD_INVALID: the cancel failed refund rule R (${rule})`);
    this.name = 'CancelBuildInvalidError';
  }
}

export type BuildResult =
  | { readonly kind: 'built'; readonly built: BuiltCancel }
  /** `OwnerUtxoRequiredError`: no token-free owner coin large enough for `cancel()`. */
  | { readonly kind: 'needs_coin'; readonly requiredSatoshis: bigint; readonly largestSatoshis: bigint };

const finish = (
  onChain: OrderOnChain,
  path: CancelPath,
  draft: UnsignedTransactionDraft,
  ownerCoin: Utxo | null,
): BuiltCancel => {
  const ruleContext: CancelRuleContext = {
    path,
    ownerLockingBytecode: onChain.ownerLocking,
    order: coinFacts(onChain.orderUtxo),
    maxNetworkFee: onChain.params.maxNetworkFee,
    ownerCoin: ownerCoin === null ? null : coinFacts(ownerCoin),
  };
  const transaction = decodeTransactionHex(draft.unsignedHex);
  const rule = checkCancelRules(transaction, ruleContext);
  if (rule !== null) throw new CancelBuildInvalidError(rule, draft.unsignedHex);
  const refund = transaction.outputs[refundIndex(path)];
  return {
    path,
    draft,
    ownerCoin,
    refundSats: refund?.valueSatoshis ?? 0n,
    refundTokens: refund?.token?.amount ?? 0n,
    fee: draft.fee,
    ruleContext,
  };
};

const USER_PROMPT = 'Cancel AtPrice order and refund it to your owner address';

/** `cancel()` with every UTXO at the owner address; the builder picks input 0 itself (core-api.md). */
export const buildOwnerCancel = async (chain: ChainAccess, onChain: OrderOnChain): Promise<BuildResult> => {
  const ownerUtxos = (await chain.getUtxos(onChain.ownerLocking)).map(toUtxo);
  try {
    const draft = buildCancelTransaction({
      owner: { utxos: ownerUtxos },
      orders: [{ order: onChain.order, utxo: onChain.orderUtxo }],
      userPrompt: USER_PROMPT,
    });
    return { kind: 'built', built: finish(onChain, 'cancel', draft, draft.ownerUtxo) };
  } catch (error) {
    if (error instanceof OwnerUtxoRequiredError) {
      return {
        kind: 'needs_coin',
        requiredSatoshis: error.requiredSatoshis,
        largestSatoshis: error.largestSatoshis,
      };
    }
    throw error;
  }
};

/** `cancelWithSig`, only for wallets that fill CashScript placeholders. */
export const buildSignatureCancel = (onChain: OrderOnChain): BuiltCancel =>
  finish(
    onChain,
    'cancelWithSig',
    buildCancelWithSigTransaction({
      orders: [{ order: onChain.order, utxo: onChain.orderUtxo }],
      userPrompt: USER_PROMPT,
    }),
    null,
  );
