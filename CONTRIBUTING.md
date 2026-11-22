# Contributing to AtPrice

Thanks for taking the time to look at AtPrice. Bug reports, reviews of the contracts and fixes are all welcome. This page covers how to get a working checkout, what CI checks, and the few rules that matter because real funds sit in these covenants.

If you found something that could put user funds at risk, don't open an issue. Follow [SECURITY.md](SECURITY.md) instead.

## Getting set up

You need:

- Node 24.19.0. The version is in [`.nvmrc`](.nvmrc), so `nvm use` or `fnm use` picks it up.
- pnpm 12.16.1, pinned by `packageManager` in [`package.json`](package.json). `corepack enable` installs the right version.
- PostgreSQL 16, only for the `apps/server` integration tests.

```sh
pnpm install --frozen-lockfile
NEXT_PUBLIC_ATPRICE_NETWORK=chipnet NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm build
```

The web app refuses to build without `NEXT_PUBLIC_ATPRICE_NETWORK` and `NEXT_PUBLIC_API_URL`. The values above are the ones CI uses. Running the API, keeper and web app locally is covered in the README under [Local setup](README.md#local-setup).

## Checks

CI runs these on every push to `main` and every pull request, in this order. Run them before you open a pull request:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm audit --prod
```

`pnpm format` fixes formatting. The server's integration tests reset a database whose name must contain `atprice_test`, passed as `TEST_DATABASE_URL`, for example `postgres://localhost:5432/atprice_test`. The live chipnet suites (`pnpm --filter @atprice/server test:live`, `pnpm --filter @atprice/chain test:live`) talk to public servers and are not part of CI.

## Where things live

| Path                  | What it is                                                                      |
| --------------------- | ------------------------------------------------------------------------------- |
| `packages/contracts`  | CashScript sources, compiled artifacts, unit and adversarial tests              |
| `packages/core`       | order params, OP_RETURN codec, quote maths, transaction builders, state machine |
| `packages/chain`      | Electrum, Rostrum and Cauldron indexer clients                                  |
| `packages/api-schema` | zod schemas shared by the API and the web app                                   |
| `apps/server`         | API and keeper, plus SQL migrations                                             |
| `apps/web`            | Next.js web app                                                                 |
| `apps/recover`        | the standalone recovery HTML file and `pnpm recover`                            |
| `docs`                | architecture, contract rules, recovery and the runbook                          |

## Rules for changes

Contracts. Any change to `packages/contracts/src/*.cash` changes the compiled bytecode, which changes every order address and makes existing orders unrecoverable by the new code. Treat it as a new contract version: bump the `ATPR` record version, keep the old artifacts so old orders can still be found and cancelled, add adversarial tests for every rule you touch, and update [docs/contract.md](docs/contract.md) and the fingerprints in it. Run `pnpm --filter @atprice/contracts compile` and commit the regenerated artifacts with the source change.

Recovery. `apps/recover` must keep working with no AtPrice host. Don't add a request to any AtPrice domain, and don't add anything that asks for a private key. The build is reproducible, so a change that alters the output should say so in the pull request.

Keys and secrets. No private keys, seeds or real `.env` files in commits, tests or fixtures. Use throwaway keys generated for the test.

Money. Amounts are integers (`bigint` in TypeScript, `numeric(78,0)` in Postgres). Don't introduce floating-point maths anywhere an amount, rate or fee is computed.

Docs. If a change makes a statement in the README or `docs/` untrue, fix the doc in the same pull request.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): an imperative subject such as `fix(keeper): retry on a spent pool output`, and a body that says why the change is needed. Keep commits small enough to review one at a time.

A pull request should explain the problem, what changed and how you tested it. If it touches the contracts, the recover file or the keeper's fill path, say so at the top. User-facing changes get a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).

By contributing you agree that your work is released under the [MIT license](LICENSE), and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
