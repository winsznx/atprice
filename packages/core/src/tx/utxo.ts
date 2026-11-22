import { hexToBin, type Output } from '@bitauth/libauth';
import type { Utxo } from 'cashscript';

/** The libauth source output of a CashScript UTXO whose locking bytecode is known. */
export const utxoSourceOutput = (utxo: Utxo & { readonly lockingBytecode: string }): Output => {
  const token = utxo.token;
  return {
    lockingBytecode: hexToBin(utxo.lockingBytecode),
    valueSatoshis: utxo.satoshis,
    ...(token && {
      token: {
        category: hexToBin(token.category),
        amount: token.amount,
        ...(token.nft && {
          nft: { capability: token.nft.capability, commitment: hexToBin(token.nft.commitment) },
        }),
      },
    }),
  };
};
