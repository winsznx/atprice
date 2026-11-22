import {
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  encodeHdPublicKey,
  hexToBin,
} from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { networkConfigFor } from '../network';
import {
  ownerIdentity,
  walletNetworkLabel,
  walletNetworkMatches,
  xpubNetwork,
  XpubDecodeError,
} from './keys';

const node = deriveHdPublicNode(deriveHdPrivateNodeFromSeed(hexToBin('000102030405060708090a0b0c0d0e0f')));
const xpub = encodeHdPublicKey({ network: 'mainnet', node }).hdPublicKey;
const tpub = encodeHdPublicKey({ network: 'testnet', node }).hdPublicKey;

describe('wallet network from the xpub version (research/wizardconnect.md section 8)', () => {
  it('reads mainnet and testnet', () => {
    expect(xpub.startsWith('xpub')).toBe(true);
    expect(xpubNetwork(xpub)).toBe('mainnet');
    expect(xpubNetwork(tpub)).toBe('testnet');
  });

  it('matches a chipnet build only with a tpub and a mainnet build only with an xpub', () => {
    expect(walletNetworkMatches(tpub, networkConfigFor('chipnet'))).toBe(true);
    expect(walletNetworkMatches(xpub, networkConfigFor('chipnet'))).toBe(false);
    expect(walletNetworkMatches(xpub, networkConfigFor('mainnet'))).toBe(true);
  });

  it('labels a tpub as a test network, never as chipnet', () => {
    expect(walletNetworkLabel('testnet')).toBe('a test network');
  });

  it('names an undecodable xpub', () => {
    expect(() => xpubNetwork('xpub-not-real')).toThrow(XpubDecodeError);
  });
});

describe('owner identity from receive/0', () => {
  it('derives the owner hash and both address forms with the network prefix', () => {
    const owner = ownerIdentity(node.publicKey, networkConfigFor('chipnet'));
    expect(owner.ownerPkhHex).toMatch(/^[0-9a-f]{40}$/);
    expect(owner.address.startsWith('bchtest:q')).toBe(true);
    expect(owner.tokenAddress.startsWith('bchtest:z')).toBe(true);
    expect(
      ownerIdentity(node.publicKey, networkConfigFor('mainnet')).address.startsWith('bitcoincash:q'),
    ).toBe(true);
  });
});
