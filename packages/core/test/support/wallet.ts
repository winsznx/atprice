import {
  binToHex,
  decodeTransactionBch,
  encodeDataPush,
  encodeTransactionBch,
  flattenBinArray,
  generateSigningSerializationBch,
  hash256,
  hexToBin,
  secp256k1,
  type Output,
} from '@bitauth/libauth';
import type { RelaySourceOutput, WalletPathName, WizardConnectSignRequest } from '../../src/index.js';

const SIGHASH_ALL_UTXOS_FORKID = 0x61;
const SIGNATURE_PLACEHOLDER = `41${'00'.repeat(65)}`;
const PUBLIC_KEY_PLACEHOLDER = `21${'00'.repeat(33)}`;

const relayBigInt = (value: string): bigint => {
  const match = /^<bigint: (\d+)n>$/.exec(value);
  if (match?.[1] === undefined) throw new Error(`not a relay bigint: ${value}`);
  return BigInt(match[1]);
};

const toOutput = (source: RelaySourceOutput): Output => ({
  lockingBytecode: hexToBin(source.lockingBytecode),
  valueSatoshis: relayBigInt(source.valueSatoshis),
  ...(source.token && {
    token: {
      category: hexToBin(source.token.category),
      amount: relayBigInt(source.token.amount),
      ...(source.token.nft && {
        nft: { capability: source.token.nft.capability, commitment: hexToBin(source.token.nft.commitment) },
      }),
    },
  }),
});

export type WalletKeys = ReadonlyMap<`${WalletPathName}/${number}`, Uint8Array>;

/**
 * Signs a WizardConnect request the way Paytaca and Cashonize do (research/wizardconnect.md 0.4):
 * the request only crosses the wire as JSON; every listed input is signed with SIGHASH
 * ALL|UTXOS|FORKID; a listed input with `contract` info gets its placeholders replaced (signing over
 * the redeem script), any other listed input becomes `<sig> <pubkey>`. Unlisted inputs are untouched.
 */
export const signAsWallet = (request: WizardConnectSignRequest, keys: WalletKeys): string => {
  const wire = JSON.parse(JSON.stringify(request)) as WizardConnectSignRequest;
  const transaction = decodeTransactionBch(hexToBin(wire.transaction.transaction));
  if (typeof transaction === 'string') throw new Error(transaction);
  const sourceOutputs = wire.transaction.sourceOutputs.map(toOutput);
  const signed = wire.inputPaths.map(([inputIndex, pathName, addressIndex]) => {
    const privateKey = keys.get(`${pathName}/${addressIndex}`);
    const source = wire.transaction.sourceOutputs[inputIndex];
    if (privateKey === undefined || source === undefined)
      throw new Error(`wallet has no key for input ${inputIndex}`);
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    const coveredBytecode = source.contract
      ? hexToBin(source.contract.redeemScript)
      : hexToBin(source.lockingBytecode);
    const serialization = generateSigningSerializationBch(
      { inputIndex, sourceOutputs, transaction },
      { coveredBytecode, signingSerializationType: Uint8Array.of(SIGHASH_ALL_UTXOS_FORKID) },
    );
    const signature = secp256k1.signMessageHashSchnorr(privateKey, hash256(serialization));
    if (typeof signature === 'string') throw new Error(signature);
    const fullSignature = flattenBinArray([signature, Uint8Array.of(SIGHASH_ALL_UTXOS_FORKID)]);
    const unlockingBytecode = source.contract
      ? hexToBin(
          source.unlockingBytecode
            .replace(SIGNATURE_PLACEHOLDER, binToHex(encodeDataPush(fullSignature)))
            .replace(PUBLIC_KEY_PLACEHOLDER, binToHex(encodeDataPush(publicKey))),
        )
      : flattenBinArray([encodeDataPush(fullSignature), encodeDataPush(publicKey)]);
    return [inputIndex, unlockingBytecode] as const;
  });
  for (const [inputIndex, unlockingBytecode] of signed) {
    const input = transaction.inputs[inputIndex];
    if (input === undefined) throw new Error(`no input ${inputIndex}`);
    input.unlockingBytecode = unlockingBytecode;
  }
  return binToHex(encodeTransactionBch(transaction));
};
