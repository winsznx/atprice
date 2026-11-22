import { describe, expect, it } from 'vitest';
import { placeholderSigningWallet } from './placeholder-wallets';

describe('placeholderSigningWallet', () => {
  it('matches a listed wallet by whole word, in any case', () => {
    expect(placeholderSigningWallet('Paytaca')).toBe('Paytaca');
    expect(placeholderSigningWallet('Paytaca Wallet')).toBe('Paytaca');
    expect(placeholderSigningWallet('cashonize')).toBe('Cashonize');
  });

  it('does not offer cancelWithSig to an unlisted wallet, a name that only contains one, or no name', () => {
    expect(placeholderSigningWallet('Electron Cash')).toBeNull();
    expect(placeholderSigningWallet('NotPaytacaFork')).toBeNull();
    expect(placeholderSigningWallet(null)).toBeNull();
  });
});
