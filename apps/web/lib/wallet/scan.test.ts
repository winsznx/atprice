import { binToHex, encodeLockingBytecodeP2pkh, hash160 } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import type { ChainAccess, ChainUtxo, HistoryEntry } from '../chain/types';
import { GAP_LIMIT } from './constants';
import { scanWallet, type PubkeyAt } from './scan';

const keyFor = (path: string, index: number): Uint8Array => {
  const key = new Uint8Array(33);
  key[0] = 2;
  key[1] = path === 'receive' ? 1 : 2;
  key[2] = index;
  return key;
};
const lockingHex = (path: string, index: number): string =>
  binToHex(encodeLockingBytecodeP2pkh(hash160(keyFor(path, index))));

const fakeChain = (funded: Record<string, ChainUtxo[]>): ChainAccess & { queried: string[] } => {
  const queried: string[] = [];
  return {
    queried,
    endpointLabel: 'fake:1',
    getHistory: async (bytecode: Uint8Array): Promise<HistoryEntry[]> => {
      queried.push(binToHex(bytecode));
      return funded[binToHex(bytecode)] === undefined ? [] : [{ txid: 'c'.repeat(64), height: 10 }];
    },
    getUtxos: async (bytecode: Uint8Array) => funded[binToHex(bytecode)] ?? [],
    getRawTransaction: async () => '',
    getTransactionStatus: async () => ({ hex: '', confirmations: 0, blockHash: null }),
    getTip: async () => ({ height: 1, hex: '', hash: '' }),
    broadcast: async () => '',
    subscribeAddress: async () => async () => undefined,
  };
};

const pubkeyAt: PubkeyAt = (path, index) => keyFor(path, index);

describe('wallet scan (wallet.md "Balances")', () => {
  it('maps each UTXO to its path and index and keeps token UTXOs out of the BCH balance', async () => {
    const chain = fakeChain({
      [lockingHex('receive', 0)]: [{ txid: 'a'.repeat(64), vout: 0, satoshis: 10_000n, height: 5 }],
      [lockingHex('receive', 3)]: [
        {
          txid: 'b'.repeat(64),
          vout: 1,
          satoshis: 800n,
          height: 5,
          token: { category: 'd'.repeat(64), amount: 42n },
        },
      ],
      [lockingHex('change', 1)]: [{ txid: 'e'.repeat(64), vout: 2, satoshis: 5_000n, height: 0 }],
    });
    const scan = await scanWallet(chain, pubkeyAt);
    expect(scan.bchSats).toBe(15_000n);
    expect(scan.tokens).toEqual([{ category: 'd'.repeat(64), fungible: 42n, nftCount: 0 }]);
    expect(scan.addressesWithCoins).toBe(3);
    expect(scan.utxos.find((utxo) => utxo.vout === 1)).toMatchObject({
      pathName: 'receive',
      addressIndex: 3,
    });
  });

  it('stops each path after the gap limit of unused addresses', async () => {
    const chain = fakeChain({
      [lockingHex('receive', 2)]: [{ txid: 'a'.repeat(64), vout: 0, satoshis: 1n, height: 5 }],
    });
    await scanWallet(chain, pubkeyAt);
    const receiveQueries = chain.queried.filter((hex) =>
      Array.from({ length: 40 }, (_, index) => lockingHex('receive', index)).includes(hex),
    );
    expect(receiveQueries).toHaveLength(3 + GAP_LIMIT);
  });
});
