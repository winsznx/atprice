/*
 * Imported by apps/recover by relative path (web-requests-recover.md R9), so this module must stay
 * free of imports from lib/api, lib/env, lib/network, lib/notifications, components and app.
 */

/**
 * Wallets whose source fills CashScript signature and pubkey placeholders inside a contract input
 * (research/wizardconnect.md section 7: Paytaca f4746030, Cashonize 78e09845, Selene 2026-10-14), so
 * they can sign `cancelWithSig`. Read from source only: each wallet's released store build (Paytaca
 * v0.27.3, Cashonize 0.16.0, Selene 2026.10.02) still needs the live chipnet `cancelWithSig` round
 * trip, and a wallet that fails it must be removed here. The web cancel and Recover share this list.
 */
export const PLACEHOLDER_SIGNING_WALLETS = ['Paytaca', 'Cashonize', 'Selene'] as const;

/**
 * `wallet_ready` carries a free-text name; match a listed wallet as a whole word, case-insensitively,
 * so `Paytaca` and `Cashonize Wallet` match and `NotPaytacaFork` doesn't.
 */
export const placeholderSigningWallet = (walletName: string | null): string | null => {
  if (walletName === null) return null;
  const name = walletName.toLowerCase();
  return (
    PLACEHOLDER_SIGNING_WALLETS.find((listed) =>
      new RegExp(`(^|[^a-z])${listed.toLowerCase()}([^a-z]|$)`).test(name),
    ) ?? null
  );
};
