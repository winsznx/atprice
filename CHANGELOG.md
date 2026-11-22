# Changelog

All notable changes to AtPrice are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A change to the order covenants is always a new contract version and a major release, because it changes every order address.

## [Unreleased]

## [1.0.0] - 2026-11-22

First public release, submitted to the BCH BLAZE 2026 Mainnet Track. AtPrice runs on Bitcoin Cash mainnet with PUSD and RES markets, and on chipnet with PUSDTEST.

### Added

- Order covenants `AtPriceBuy` and `AtPriceSell` (contract v1), compiled with cashc 0.14.0. Each order is a P2SH32 output with three spend paths: `execute` through one genuine Cauldron V0 pool that pays the owner at least `minOut`, `cancel` authorized by an owner P2PKH input, and `cancelWithSig` with the owner's signature. Artifact fingerprints are listed in [docs/contract.md](docs/contract.md).
- The `ATPR` OP_RETURN record (version `0x01`), written by every funding transaction, which carries every order parameter so any order can be rebuilt from chain data alone.
- `packages/core`: market allowlist, order parameters, record codec, exact quote maths, funding, fill and cancel builders, and the order state machine.
- `packages/chain`: Electrum client with failover for the browser and Node, Rostrum and Cauldron indexer clients, broadcast and explorer links.
- `packages/api-schema`: zod schemas for every API response, shared by the server and the web app.
- `apps/server`: the Fastify 5 API and the keeper, two processes from one image. The keeper watches every market's Cauldron pools, fills orders that a single pool can satisfy, verifies each fill in the `BCH_2026_05` VM before broadcast, and holds no key. `GET /api/v1/health` is judged by an evaluator the keeper can't write to. PostgreSQL migrations are plain SQL.
- `apps/web`: the Next.js 16 web app with trade, markets, orders, activity, evidence and recover pages. Order parameters are derived in the browser from the wallet's xpub, which never leaves the page, and the wallet signs over WizardConnect.
- `apps/recover`: one self-contained HTML file per network and the `pnpm recover` CLI, which find an order on chain and cancel it with the owner's wallet without any AtPrice host. The build is reproducible and writes each file's SHA-256 to `apps/recover/dist/manifest.json`.
- Unit, integration and adversarial tests: 77 test files and 1,248 tests on 2026-11-22. The adversarial suite runs the compiled artifacts against the real Cauldron V0 template.
- The Phase 0 chipnet harness and the chipnet transactions listed in the README under "Verify it yourself".
- Deployment files: Docker Compose stacks for the API, keeper and Postgres, with or without a bundled Caddy, and a prebuilt Vercel deploy for the web app.
- Docs: architecture, contract rules, recovery, the operations runbook and the security policy.
- Repository tooling: CI, CodeQL analysis, Dependabot, issue forms, a pull request template, a contributing guide and a code of conduct.

### Security

- Not independently audited. See [SECURITY.md](SECURITY.md) for the trust model and how to report a vulnerability.
- The protocol fee is 0%, and this contract version has no way to add one.

[Unreleased]: https://github.com/winsznx/atprice/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/winsznx/atprice/releases/tag/v1.0.0
