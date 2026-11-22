# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's Security tab at https://github.com/winsznx/atprice/security and choose "Report a vulnerability". Please don't open a public issue for anything that could put user funds at risk.

Include what you found, the affected file or contract function, and a way to reproduce it. A chipnet transaction or a failing test against the compiled artifacts is the most useful form. We will acknowledge the report, keep you informed while we work on it, and credit you when the fix is published unless you ask us not to.

In scope: the order covenants in [`packages/contracts/src`](packages/contracts/src), the transaction builders in [`packages/core`](packages/core), the recover file and CLI in [`apps/recover`](apps/recover), the API and keeper in [`apps/server`](apps/server), and the web app in [`apps/web`](apps/web).

## Audit status

AtPrice has not been independently audited. The contracts, builders and keeper were reviewed internally by the people who built them, which is not a substitute for an outside audit. The test suites (420 contract tests, including an adversarial suite, run against the compiled artifacts in the `BCH_2026_05` VM) and the chipnet transactions listed in the [README](README.md#verify-it-yourself) show the contract behaving as described, but they cannot prove the absence of bugs. Only lock amounts you are prepared to lose.

## Trust model

What you don't have to trust AtPrice for:

- Custody. Orders sit in a covenant locked to your parameters. AtPrice has no key that can move them. The keeper holds no key at all, because a fill needs no signature and adds no AtPrice input or output.
- Your minimum. The contract only lets a fill through if your recipient receives at least `minOut`, in the token you chose, through a genuine Cauldron V0 pool spent via its exchange branch.
- Fees. A fill or cancel can spend at most your `maxNetworkFee` (1,000 to 5,000 sats) on miner fee. There is no protocol fee output, and this contract version can't add one.
- Your key. The xpub never leaves your browser and no AtPrice tool ever asks for a private key. Your wallet signs over WizardConnect.
- Getting your funds back. Only your key can cancel, and the refund must go to your address with the same tokens. The recover file and `pnpm recover` work with any public Electrum server and no AtPrice host ([docs/recovery.md](docs/recovery.md)).

What you do rely on AtPrice for:

- Timely fills. If the keeper is down, your order waits. It doesn't fill at a worse price and stays cancellable. `GET /api/v1/health` reports whether the keeper is keeping up, judged by an evaluator the keeper can't write to.
- Best execution above your limit. The contract guarantees `minOut`, not the best price. Anyone can fill your order, and a filler can route through a pool priced at exactly your limit and keep the improvement. AtPrice's keeper picks the single public pool with the best output, which is policy, not something the contract enforces.
- The web app showing you the right parameters. The browser derives them itself from your wallet and the bundled artifacts, never from values echoed by the API, and the confirmation screen shows them before you sign. Your wallet's signing screen is the final check.

Other limits: one pool per fill, fill or kill, good till cancelled, and fills need a Cauldron V0 pool for the token. Token identity comes only from the allowlist in [`packages/core/src/markets.ts`](packages/core/src/markets.ts), never from an indexer at runtime.

## Operational security

The server stack's secrets are its database password and Electrum settings, kept in an env file outside the repository. There is no mainnet keeper key. Postgres has no published port. The API validates every input with zod, limits bodies to 16 KB, rate-limits writes per IP and logs no xpubs or request bodies. The web app ships a strict Content-Security-Policy and no third-party scripts.
