import {
  binToHex,
  decodeAuthenticationInstructions,
  encodeLockingBytecodeP2pkh,
  type AuthenticationInstructionMaybeMalformed,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { bytesEqual } from './bytes.js';
import {
  poolLockingBytecode,
  CAULDRON_V0_PREFIX,
  CAULDRON_V0_REDEEM_SCRIPT_LENGTH,
  CAULDRON_V0_SUFFIX,
} from './cauldron.js';
import { BUY_PAYOUT_SATS } from './constants.js';
import { orderArtifact, orderRedeemScript, type OrderParams } from './order.js';

/** How an order UTXO was spent, decoded from its unlocking bytecode and re-verified against the outputs. */
export type OrderSpend =
  | {
      readonly path: 'execute';
      readonly poolOwnerPkh: string;
      /** Pool output after the fill (output 0). */
      readonly poolAfter: { readonly sats: bigint; readonly tokens: bigint };
      /** Buy: token units delivered. Sell: satoshis paid to the recipient. */
      readonly delivered: bigint;
      readonly payoutSatoshis: bigint;
    }
  | {
      readonly path: 'cancel';
      readonly authorization: 'cancel' | 'cancelWithSig';
      readonly refundVout: number;
    }
  | { readonly path: 'unknown'; readonly reason: SpendUnknownReason };

export type SpendUnknownReason =
  'not_order_redeem_script' | 'unknown_function' | 'malformed_unlocking' | 'execute_shape' | 'cancel_shape';

/** The spent order UTXO, as recorded when it was created. */
export interface SpentOrderOutput {
  readonly satoshis: bigint;
  readonly token?: {
    readonly category: string;
    readonly amount: bigint;
    readonly nft?: { readonly capability: string; readonly commitment: string };
  };
}

const OP_0 = 0x00;
const OP_1 = 0x51;
const OP_16 = 0x60;

const pushedData = (
  instruction: AuthenticationInstructionMaybeMalformed | undefined,
): Uint8Array | undefined =>
  instruction !== undefined && 'data' in instruction && !('malformed' in instruction && instruction.malformed)
    ? instruction.data
    : undefined;

const pushedSmallInt = (
  instruction: AuthenticationInstructionMaybeMalformed | undefined,
): number | undefined => {
  if (instruction === undefined) return undefined;
  if (instruction.opcode === OP_0) return 0;
  if (instruction.opcode >= OP_1 && instruction.opcode <= OP_16) return instruction.opcode - OP_1 + 1;
  const data = pushedData(instruction);
  if (data?.length === 1 && data[0] !== undefined && data[0] <= 0x7f) return data[0];
  return undefined;
};

const unknown = (reason: SpendUnknownReason): OrderSpend => ({ path: 'unknown', reason });

const tokenMatches = (output: Output, spent: SpentOrderOutput): boolean => {
  if (spent.token === undefined) return output.token === undefined;
  const token = output.token;
  if (token === undefined) return false;
  if (binToHex(token.category) !== spent.token.category || token.amount !== spent.token.amount) return false;
  if (spent.token.nft === undefined) return token.nft === undefined;
  return (
    token.nft !== undefined &&
    token.nft.capability === spent.token.nft.capability &&
    binToHex(token.nft.commitment) === spent.token.nft.commitment
  );
};

/** Pool owner hash from an exchange-branch pool unlocking bytecode (`0x44 ‖ redeem script`). */
const poolOwnerFromUnlocking = (unlocking: Uint8Array): Uint8Array | undefined => {
  if (
    unlocking.length !== CAULDRON_V0_REDEEM_SCRIPT_LENGTH + 1 ||
    unlocking[0] !== CAULDRON_V0_REDEEM_SCRIPT_LENGTH
  ) {
    return undefined;
  }
  const script = unlocking.subarray(1);
  const prefixEnd = CAULDRON_V0_PREFIX.length;
  const pkhEnd = prefixEnd + 20;
  if (!bytesEqual(script.subarray(0, prefixEnd), CAULDRON_V0_PREFIX)) return undefined;
  if (!bytesEqual(script.subarray(pkhEnd), CAULDRON_V0_SUFFIX)) return undefined;
  return script.slice(prefixEnd, pkhEnd);
};

/**
 * Classifies the spend of an order UTXO at `inputIndex` (architecture.md, indexer): the function
 * selector is decoded from the unlocking bytecode, the redeem script must be the order's own, and
 * the outputs are re-verified against the path the selector names. Anything else is `unknown`, which
 * moves the order to RECONCILIATION_REQUIRED.
 */
export const classifyOrderSpend = (
  transaction: TransactionCommon,
  inputIndex: number,
  params: OrderParams,
  spent: SpentOrderOutput,
): OrderSpend => {
  const input = transaction.inputs[inputIndex];
  if (input === undefined) return unknown('malformed_unlocking');
  const instructions = decodeAuthenticationInstructions(input.unlockingBytecode);
  const redeem = pushedData(instructions.at(-1));
  if (redeem === undefined) return unknown('malformed_unlocking');
  if (!bytesEqual(redeem, orderRedeemScript(params))) return unknown('not_order_redeem_script');
  const selector = pushedSmallInt(instructions.at(-2));
  const abi = orderArtifact(params.side).abi;
  const functionName = selector === undefined ? undefined : abi[selector]?.name;
  if (functionName === undefined) return unknown('unknown_function');

  if (functionName === 'execute') {
    const poolInput = transaction.inputs[0];
    const poolOutput = transaction.outputs[0];
    const payout = transaction.outputs[1];
    const argPkh = pushedData(instructions.at(-3));
    if (
      inputIndex !== 1 ||
      transaction.inputs.length !== 2 ||
      transaction.outputs.length !== 2 ||
      poolInput === undefined ||
      poolOutput === undefined ||
      payout === undefined ||
      argPkh?.length !== 20
    ) {
      return unknown('execute_shape');
    }
    const poolPkh = poolOwnerFromUnlocking(poolInput.unlockingBytecode);
    if (
      poolPkh === undefined ||
      !bytesEqual(poolPkh, argPkh) ||
      !bytesEqual(poolOutput.lockingBytecode, poolLockingBytecode(poolPkh)) ||
      poolOutput.token === undefined ||
      binToHex(poolOutput.token.category) !== params.tokenCategory ||
      !bytesEqual(payout.lockingBytecode, params.recipientLockingBytecode)
    ) {
      return unknown('execute_shape');
    }
    let delivered: bigint;
    if (params.side === 'buy') {
      if (
        payout.token === undefined ||
        binToHex(payout.token.category) !== params.tokenCategory ||
        payout.valueSatoshis !== BUY_PAYOUT_SATS
      ) {
        return unknown('execute_shape');
      }
      delivered = payout.token.amount;
    } else {
      if (payout.token !== undefined) return unknown('execute_shape');
      delivered = payout.valueSatoshis;
    }
    if (delivered < params.minOut) return unknown('execute_shape');
    return {
      path: 'execute',
      poolOwnerPkh: binToHex(poolPkh),
      poolAfter: { sats: poolOutput.valueSatoshis, tokens: poolOutput.token.amount },
      delivered,
      payoutSatoshis: payout.valueSatoshis,
    };
  }

  if (functionName === 'cancel' || functionName === 'cancelWithSig') {
    const refund = transaction.outputs[inputIndex];
    if (
      refund === undefined ||
      !bytesEqual(refund.lockingBytecode, encodeLockingBytecodeP2pkh(params.ownerPkh)) ||
      !tokenMatches(refund, spent) ||
      refund.valueSatoshis < spent.satoshis - params.maxNetworkFee
    ) {
      return unknown('cancel_shape');
    }
    return { path: 'cancel', authorization: functionName, refundVout: inputIndex };
  }
  return unknown('unknown_function');
};
