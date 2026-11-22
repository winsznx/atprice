import {
  encodeLockingBytecodeP2pkh,
  getDustThreshold,
  hexToBin,
  isPayToPublicKeyHash,
} from '@bitauth/libauth';
import {
  TransactionBuilder,
  type NetworkProvider,
  type Output,
  type PlaceholderP2PKHUnlocker,
  type Utxo,
} from 'cashscript';
import { FUNDING_MARKER_SATS, MIN_RELAY_FEE_PER_BYTE } from '../constants.js';
import { InsufficientFundsError, TransactionBuildError } from '../errors.js';
import {
  orderAddresses,
  orderFunding,
  validateOrderShape,
  type Network,
  type OrderFunding,
  type OrderParams,
} from '../order.js';
import { encodeOrderRecord } from '../record.js';
import {
  toWizardConnectDraft,
  type InputPath,
  type UnsignedTransactionDraft,
  type WalletPathName,
} from './wizardconnect.js';

/** A P2PKH UTXO of the user's wallet with the HD path of the key that signs it. */
export interface WalletUtxo extends Utxo {
  readonly lockingBytecode: string;
  readonly pathName: WalletPathName;
  readonly addressIndex: number;
}

export interface FundingRequest {
  readonly params: OrderParams;
  /** Buy: satoshis to spend in the pool. Sell: token units to sell. */
  readonly amount: bigint;
  /** The market minimum for this side, in the same unit as `amount`. */
  readonly minimumAmount: bigint;
  readonly walletUtxos: readonly WalletUtxo[];
  readonly network: Network;
  /** Used only to instantiate the CashScript builder; nothing is sent through it. */
  readonly provider: NetworkProvider;
  readonly feePerByte?: bigint;
  readonly userPrompt?: string;
}

export interface FundingDraft extends UnsignedTransactionDraft {
  readonly funding: OrderFunding;
  readonly orderLockingBytecode: Uint8Array;
  readonly orderAddress: string;
  readonly record: Uint8Array;
  /** Satoshis of output 2 (token-free owner change, at least the 1000-sat marker). */
  readonly ownerOutputSatoshis: bigint;
  /** Token units returned on output 3 (sell funding from a larger token UTXO); 0 when it is absent. */
  readonly ownerTokenChange: bigint;
}

const placeholder = (lockingBytecode: string): PlaceholderP2PKHUnlocker => ({
  generateUnlockingBytecode: () => new Uint8Array(),
  placeholder: true,
  lockingBytecode,
});

const descending = (a: bigint, b: bigint): number => (b > a ? 1 : b < a ? -1 : 0);

const total = (values: readonly bigint[]): bigint => values.reduce((sum, value) => sum + value, 0n);

/** Funding output 3: the owner's token change in its own output, at exactly its dust threshold. */
const ownerTokenChange = (ownerLocking: Uint8Array, category: string, amount: bigint): Output => ({
  to: ownerLocking,
  amount: getDustThreshold({
    lockingBytecode: ownerLocking,
    valueSatoshis: 0n,
    token: { category: hexToBin(category), amount },
  }),
  token: { category, amount },
});

const isPlainFungible = (utxo: Utxo, category: string): boolean =>
  utxo.token !== undefined &&
  utxo.token.category === category &&
  utxo.token.nft === undefined &&
  utxo.token.amount > 0n;

/**
 * Funding transaction per the contract spec: outputs `[0] order covenant, [1] OP_RETURN record,
 * [2] P2PKH(ownerPkh) change` (token-free, at least the 1000-sat marker, so owner-address history
 * finds every order) and, only for a sell funded from more tokens than it sells, `[3] P2PKH(ownerPkh)`
 * token change at its dust threshold.
 *
 * Token-aware coin selection (architecture.md, order creation step 5): satoshis come only from
 * token-free UTXOs, largest first. A sell additionally spends plain fungible UTXOs of the market
 * token, largest first; no other token UTXO (NFTs included, of any category) is ever an input, so
 * every token in the inputs reaches an output. The fee is `size * feePerByte` with wallet inputs
 * counted at their signed size. Every input is a wallet P2PKH listed in `inputPaths`.
 *
 * Funding is the one step that commits money to a covenant, so it re-checks every domain rule
 * except the market allowlist (`validateOrderShape`) and throws before building anything.
 */
export const buildFundingTransaction = (request: FundingRequest): FundingDraft => {
  const { params } = request;
  validateOrderShape(params);
  const feePerByte = request.feePerByte ?? MIN_RELAY_FEE_PER_BYTE;
  for (const utxo of request.walletUtxos) {
    if (!isPayToPublicKeyHash(hexToBin(utxo.lockingBytecode))) {
      throw new TransactionBuildError(
        'wallet_utxo_invalid',
        `wallet UTXO ${utxo.txid}:${utxo.vout} is not P2PKH`,
      );
    }
  }
  const funding = orderFunding(params, request.amount, request.minimumAmount);
  const order = orderAddresses(params, request.network);
  const record = encodeOrderRecord(params);
  const ownerLocking = encodeLockingBytecodeP2pkh(params.ownerPkh);

  const tokenInputs: WalletUtxo[] = [];
  if (funding.tokenAmount > 0n) {
    const candidates = request.walletUtxos
      .filter((utxo) => isPlainFungible(utxo, params.tokenCategory))
      .sort((a, b) => descending(a.token?.amount ?? 0n, b.token?.amount ?? 0n));
    for (const utxo of candidates) {
      if (total(tokenInputs.map((input) => input.token?.amount ?? 0n)) >= funding.tokenAmount) break;
      tokenInputs.push(utxo);
    }
    const available = total(candidates.map((utxo) => utxo.token?.amount ?? 0n));
    if (available < funding.tokenAmount)
      throw new InsufficientFundsError('insufficient_tokens', funding.tokenAmount, available);
  }
  const tokenChange = total(tokenInputs.map((input) => input.token?.amount ?? 0n)) - funding.tokenAmount;
  const tokenChangeOutput =
    tokenChange > 0n ? ownerTokenChange(ownerLocking, params.tokenCategory, tokenChange) : undefined;
  const tokenChangeSatoshis = tokenChangeOutput?.amount ?? 0n;

  const assemble = (inputs: readonly WalletUtxo[], ownerSatoshis: bigint): TransactionBuilder => {
    const builder = new TransactionBuilder({
      provider: request.provider,
      allowImplicitFungibleTokenBurn: false,
    });
    for (const utxo of inputs) builder.addInput(utxo, placeholder(utxo.lockingBytecode));
    builder.addOutput({
      to: order.lockingBytecode,
      amount: funding.satoshis,
      ...(funding.tokenAmount > 0n && {
        token: { category: params.tokenCategory, amount: funding.tokenAmount },
      }),
    });
    builder.addOutput({ to: record, amount: 0n });
    builder.addOutput({ to: ownerLocking, amount: ownerSatoshis });
    if (tokenChangeOutput) builder.addOutput(tokenChangeOutput);
    return builder;
  };

  const bchCandidates = request.walletUtxos
    .filter((utxo) => utxo.token === undefined)
    .sort((a, b) => descending(a.satoshis, b.satoshis));
  const inputs = [...tokenInputs];
  for (let next = 0; ; next += 1) {
    const fee = assemble(inputs, FUNDING_MARKER_SATS).getTransactionSize() * feePerByte;
    const required = funding.satoshis + fee + FUNDING_MARKER_SATS + tokenChangeSatoshis;
    const available = total(inputs.map((utxo) => utxo.satoshis));
    if (available >= required) {
      const ownerOutputSatoshis = available - funding.satoshis - fee - tokenChangeSatoshis;
      const builder = assemble(inputs, ownerOutputSatoshis);
      const draft = toWizardConnectDraft(builder, {
        inputPaths: inputs.map((utxo, index): InputPath => [index, utxo.pathName, utxo.addressIndex]),
        contractInputs: [],
        userPrompt: request.userPrompt ?? `Fund AtPrice ${params.side} order`,
      });
      return {
        ...draft,
        funding,
        orderLockingBytecode: order.lockingBytecode,
        orderAddress: funding.tokenAmount > 0n ? order.tokenAddress : order.address,
        record,
        ownerOutputSatoshis,
        ownerTokenChange: tokenChange,
      };
    }
    const candidate = bchCandidates[next];
    if (candidate === undefined) {
      const everything = total([...tokenInputs, ...bchCandidates].map((utxo) => utxo.satoshis));
      throw new InsufficientFundsError('insufficient_bch', required, everything);
    }
    inputs.push(candidate);
  }
};
