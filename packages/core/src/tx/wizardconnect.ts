import { binToHex, encodeTransactionBch, encodeTransactionOutput, type Output } from '@bitauth/libauth';
import type { AbiFunction, TransactionBuilder } from 'cashscript';
import { bytesEqual } from '../bytes.js';
import { MIN_RELAY_FEE_PER_BYTE } from '../constants.js';
import { TransactionVerificationError } from '../errors.js';
import { assertBuilderBurnsNoToken } from './tokens.js';
import { decodeTransactionHex, verifyTransaction, type SignedTransaction } from './verify.js';

/** HD paths WizardConnect wallets accept (`receive` = m/.../0, `change` = 1, `defi` = 7). */
export type WalletPathName = 'receive' | 'change' | 'defi';

/** `[inputIndex, pathName, addressIndex]`: the inputs the wallet signs and with which key. */
export type InputPath = readonly [inputIndex: number, pathName: WalletPathName, addressIndex: number];

/** A source output in the relay-safe encoding: hex strings for bytes, `<bigint: Xn>` for amounts. */
export interface RelaySourceOutput {
  readonly outpointTransactionHash: string;
  readonly outpointIndex: number;
  readonly sequenceNumber: number;
  readonly unlockingBytecode: string;
  readonly lockingBytecode: string;
  readonly valueSatoshis: string;
  readonly token?: {
    readonly category: string;
    readonly amount: string;
    readonly nft?: { readonly capability: 'none' | 'mutable' | 'minting'; readonly commitment: string };
  };
  readonly contract?: {
    readonly abiFunction: AbiFunction;
    readonly redeemScript: string;
    readonly artifact: { readonly contractName: string };
  };
}

/** The `sign_transaction_request` payload: `mgr.signTransaction(request)` sends it unchanged. */
export interface WizardConnectSignRequest {
  readonly transaction: {
    readonly transaction: string;
    readonly sourceOutputs: readonly RelaySourceOutput[];
    readonly broadcast: false;
    readonly userPrompt: string;
  };
  readonly inputPaths: readonly InputPath[];
}

/** An unsigned transaction handed to a wallet, plus what is needed to check what comes back. */
export interface UnsignedTransactionDraft {
  readonly request: WizardConnectSignRequest;
  readonly unsignedHex: string;
  readonly sourceOutputs: readonly Output[];
  /** Size once the wallet has signed (placeholders counted at their signed length). */
  readonly estimatedSize: number;
  readonly fee: bigint;
}

const relayBigInt = (value: bigint): string => `<bigint: ${value}n>`;

/**
 * Serializes a built CashScript transaction into a WizardConnect request. Contract info is kept
 * only for inputs listed in `contractInputs`: those carry signature placeholders the wallet fills.
 * Every sign request passes the zero-burn check first and throws `TokenBurnRefused` otherwise.
 */
export const toWizardConnectDraft = (
  builder: TransactionBuilder,
  options: { inputPaths: readonly InputPath[]; contractInputs: readonly number[]; userPrompt: string },
): UnsignedTransactionDraft => {
  assertBuilderBurnsNoToken(builder);
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: options.userPrompt });
  const unsignedHex = builder.build();
  const sourceOutputs: Output[] = wc.sourceOutputs.map(({ lockingBytecode, valueSatoshis, token }) =>
    token === undefined ? { lockingBytecode, valueSatoshis } : { lockingBytecode, valueSatoshis, token },
  );
  const relaySourceOutputs = wc.sourceOutputs.map((output, index): RelaySourceOutput => {
    const contract = options.contractInputs.includes(index) ? output.contract : undefined;
    const contractName = contract?.artifact.contractName;
    if (options.contractInputs.includes(index) && contractName === undefined) {
      throw new TypeError(`input ${index} has no contract artifact to send to the wallet`);
    }
    return {
      outpointTransactionHash: binToHex(output.outpointTransactionHash),
      outpointIndex: output.outpointIndex,
      sequenceNumber: output.sequenceNumber,
      unlockingBytecode: binToHex(output.unlockingBytecode),
      lockingBytecode: binToHex(output.lockingBytecode),
      valueSatoshis: relayBigInt(output.valueSatoshis),
      ...(output.token && {
        token: {
          category: binToHex(output.token.category),
          amount: relayBigInt(output.token.amount),
          ...(output.token.nft && {
            nft: {
              capability: output.token.nft.capability,
              commitment: binToHex(output.token.nft.commitment),
            },
          }),
        },
      }),
      ...(contract &&
        contractName !== undefined && {
          contract: {
            abiFunction: contract.abiFunction,
            redeemScript: binToHex(contract.redeemScript),
            artifact: { contractName },
          },
        }),
    };
  });
  const fee =
    sourceOutputs.reduce((total, output) => total + output.valueSatoshis, 0n) -
    wc.transaction.outputs.reduce((total, output) => total + output.valueSatoshis, 0n);
  return {
    request: {
      transaction: {
        transaction: unsignedHex,
        sourceOutputs: relaySourceOutputs,
        broadcast: false,
        userPrompt: options.userPrompt,
      },
      inputPaths: options.inputPaths,
    },
    unsignedHex,
    sourceOutputs,
    estimatedSize: Number(builder.getTransactionSize()),
    fee,
  };
};

/**
 * Checks a wallet-signed transaction against its draft and returns it ready to broadcast. The wallet
 * may only change the unlocking bytecode of inputs listed in `inputPaths`; every other input is
 * restored from the draft (some wallets rewrite unlisted inputs), then the result is verified in the
 * standard-policy VM with the relay fee rule.
 */
export const finalizeWalletSignedTransaction = (
  draft: UnsignedTransactionDraft,
  signedHex: string,
  minFeePerByte: bigint = MIN_RELAY_FEE_PER_BYTE,
): SignedTransaction => {
  const unsigned = decodeTransactionHex(draft.unsignedHex);
  const signed = decodeTransactionHex(signedHex);
  const changed = (what: string): never => {
    throw new TransactionVerificationError('wallet_changed_transaction', `wallet changed ${what}`);
  };
  if (signed.version !== unsigned.version || signed.locktime !== unsigned.locktime)
    changed('version or locktime');
  if (signed.inputs.length !== unsigned.inputs.length) changed('the input count');
  if (signed.outputs.length !== unsigned.outputs.length) changed('the output count');
  signed.outputs.forEach((output, index) => {
    const original = unsigned.outputs[index];
    if (
      original === undefined ||
      !bytesEqual(encodeTransactionOutput(output), encodeTransactionOutput(original))
    ) {
      changed(`output ${index}`);
    }
  });
  const walletInputs = new Set(draft.request.inputPaths.map(([inputIndex]) => inputIndex));
  const inputs = signed.inputs.map((input, index) => {
    const original = unsigned.inputs[index];
    if (
      original === undefined ||
      !bytesEqual(input.outpointTransactionHash, original.outpointTransactionHash) ||
      input.outpointIndex !== original.outpointIndex ||
      input.sequenceNumber !== original.sequenceNumber
    ) {
      return changed(`input ${index}`);
    }
    return walletInputs.has(index) ? input : { ...input, unlockingBytecode: original.unlockingBytecode };
  });
  return verifyTransaction(
    binToHex(encodeTransactionBch({ ...signed, inputs })),
    draft.sourceOutputs,
    minFeePerByte,
  );
};
