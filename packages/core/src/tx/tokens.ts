import { binToHex, type Output, type TransactionCommon } from '@bitauth/libauth';
import type { TokenDetails, TransactionBuilder } from 'cashscript';
import { TokenBurnRefused } from '../errors.js';

interface CategoryTally {
  fungible: bigint;
  /** `capability:commitment` of every NFT, sorted, so two tallies compare as multisets. */
  readonly nfts: string[];
}

const tally = (holdings: readonly (TokenDetails | undefined)[]): Map<string, CategoryTally> => {
  const byCategory = new Map<string, CategoryTally>();
  for (const token of holdings) {
    if (token === undefined) continue;
    const category = token.category.toLowerCase();
    const entry = byCategory.get(category) ?? { fungible: 0n, nfts: [] };
    entry.fungible += token.amount;
    if (token.nft) entry.nfts.push(`${token.nft.capability}:${token.nft.commitment.toLowerCase()}`);
    byCategory.set(category, entry);
  }
  for (const entry of byCategory.values()) entry.nfts.sort();
  return byCategory;
};

const tokenOf = (output: Output): TokenDetails | undefined =>
  output.token && {
    category: binToHex(output.token.category),
    amount: output.token.amount,
    ...(output.token.nft && {
      nft: { capability: output.token.nft.capability, commitment: binToHex(output.token.nft.commitment) },
    }),
  };

/**
 * Throws {@link TokenBurnRefused} unless, for every category, the outputs carry exactly the
 * fungible amount and exactly the NFTs (capability and commitment) the inputs carry.
 */
const assertTokensConserved = (
  inputs: readonly (TokenDetails | undefined)[],
  outputs: readonly (TokenDetails | undefined)[],
): void => {
  const spent = tally(inputs);
  const created = tally(outputs);
  for (const category of new Set([...spent.keys(), ...created.keys()])) {
    const before = spent.get(category) ?? { fungible: 0n, nfts: [] };
    const after = created.get(category) ?? { fungible: 0n, nfts: [] };
    if (before.fungible !== after.fungible) {
      throw new TokenBurnRefused(
        'fungible_mismatch',
        category,
        `category ${category}: inputs carry ${before.fungible} fungible units, outputs ${after.fungible}`,
      );
    }
    if (before.nfts.join(',') !== after.nfts.join(',')) {
      throw new TokenBurnRefused(
        'nft_mismatch',
        category,
        `category ${category}: inputs carry NFTs [${before.nfts.join(', ')}], outputs [${after.nfts.join(', ')}]`,
      );
    }
  }
};

/** Zero-burn check over a libauth transaction and the outputs it spends. */
export const assertNoTokenBurn = (
  transaction: Pick<TransactionCommon, 'outputs'>,
  sourceOutputs: readonly Output[],
): void => assertTokensConserved(sourceOutputs.map(tokenOf), transaction.outputs.map(tokenOf));

/** Zero-burn check over a CashScript builder, before it serializes anything. */
export const assertBuilderBurnsNoToken = (builder: TransactionBuilder): void =>
  assertTokensConserved(
    builder.inputs.map((input) => input.token),
    builder.outputs.map((output) => output.token),
  );
