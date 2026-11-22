# Architecture

```
apps/web            Next.js 16 (app router), Tailwind 4, TanStack Query, WizardConnect in the browser
apps/server         one TypeScript package, two processes from one image
                      api     Fastify 5, zod schemas, rate limits, pino logs, independent health evaluator
                      keeper  indexer and executor, event-driven with a fallback sweep
apps/recover        standalone recovery HTML file and CLI
packages/core       no I/O: market allowlist, order params, OP_RETURN codec, contract instantiation,
                    exact quote maths, fund/execute/cancel builders, order state machine
packages/chain      Electrum client (browser and Node), Rostrum and Cauldron indexer clients
packages/contracts  CashScript sources, artifacts, tests
```

The server reads `ATPRICE_NETWORK` and the web app reads `NEXT_PUBLIC_ATPRICE_NETWORK` (`chipnet` or `mainnet`). The API reports its network and the Electrum genesis hash at `GET /api/v1/network`, and the web app blocks with a "network mismatch" state if they differ from its build.

## Order creation

The browser is the authority over its own order.

1. It derives every parameter itself with `packages/core`: `ownerPkh` from the wallet's `receive/0` public key (derived locally from the xpub), the recipient, `tokenCategory` from the allowlist, `minOut` from the typed amount and limit with exact rational maths, `maxNetworkFee`, and an 8-byte nonce from `crypto.getRandomValues`. The xpub never leaves the browser.
2. It asks the API for a quote (`GET /markets/:tokenId/quote`) and registers an intent (`POST /orders/intents`). The server re-derives the contract address and rejects a mismatch. Intents expire after 24 hours unless funding is seen, and are capped per IP and globally.
3. The browser builds the funding transaction from the wallet's UTXOs and sends a WizardConnect sign request with `broadcast: false`.
4. It broadcasts through Electrum and calls `POST /orders/register` with the txid. Registration is idempotent. If the tab closes after signing, the keeper's intent subscription still sees the funding.

The API hands intents to the keeper through Postgres `LISTEN/NOTIFY` on channel `order_intent`, and the keeper's sweep also loads any intent it missed.

## Keeper

On boot the keeper connects to Electrum, checks the genesis hash, loads open and pending orders, live intents and in-flight attempts from Postgres, subscribes every order address and every market's pools, backfills address history and reconciles in-flight attempts. The same resubscribe-and-backfill pass runs after every reconnect.

Indexer: order state changes come only from chain observations and go through one transition function in `packages/core`. A Postgres trigger enforces the same transition table, and every change writes a `transaction_events` row with its cause. Funding needs one confirmation before an order is `OPEN`, so the keeper never fills unconfirmed funding. A spend of an order is classified by decoding the function selector in its unlocking bytecode: a fill writes an `executions` row (third-party fills too), a cancel records the refund, and anything else moves the order to `RECONCILIATION_REQUIRED`. A reorg that removes a recorded confirmation does the same.

Executor: it runs on a pool change, a new block, an order becoming `OPEN`, and a fallback sweep every `KEEPER_SWEEP_INTERVAL_MS` (30 s by default). It reads pool state once per token, evaluates every open order of that token against each single pool, and fills the oldest eligible order first. One attempt per pool is in flight at a time. After a successful broadcast, the next order on that pool builds on the previous fill's unconfirmed pool output, so several orders crossed by one price move fill in one sweep. Before each broadcast it re-reads the pool UTXO, builds the 2-in-2-out transaction, verifies it in libauth's `BCH_2026_05` VM with standard policy, and writes the attempt row.

| Attempt outcome      | Meaning                                                | Retry                                           |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `not_eligible`       | no pool meets `minOut` for the whole order             | not stored per cycle                            |
| `pool_changed`       | pool UTXO spent between quote and build                | on the next pool event                          |
| `vm_rejected`        | the locally built transaction failed verification      | none until a code change; makes health degraded |
| `broadcast_rejected` | node rejected it, reason stored                        | backoff from 30 s to 30 min                     |
| `order_spent`        | order outpoint already spent                           | none; the indexer resolves it                   |
| `pool_spent`         | pool spent by someone else between build and broadcast | on the next pool event, no backoff              |
| `broadcast_ok`       | accepted to mempool                                    | wait for confirmation                           |
| `dropped`            | not in mempool after 2 sweeps                          | re-evaluate                                     |

Candidates are claimed with a lease committed before any network I/O, so a crashed keeper never holds an order. Fund safety never depends on the lease: only one spend of an order can confirm.

The keeper holds no key. A fill needs no signature and the keeper adds no inputs.

## Persistence

PostgreSQL only: `orders`, `order_intents`, `executions`, `transaction_events`, `keeper_attempts`, `markets` and `keeper_facts`. Amounts are `numeric(78,0)` and JSON carries decimal strings. Migrations are plain SQL in [`apps/server/migrations`](../apps/server/migrations). There is no Redis or job queue: the unit of work is "evaluate the open orders of a token against current pools", recomputed from chain state on every trigger.

## Health

The keeper writes timestamped facts (last header, Electrum connection, pool updates, sweeps, attempts). The API judges them against wall-clock thresholds and also runs its own evaluator, on its own Electrum connection, that reads pools from the Cauldron indexer and quotes with `@cashlab/cauldron`, a different implementation from the keeper's maths. `GET /api/v1/health` returns 200 `ok` only when every check passes, and 503 `degraded` with the failing reasons otherwise. The reasons are listed in [runbook.md](runbook.md#health). There is no switch that disables execution.

## API

All routes are under `/api/v1`: `GET /markets`, `GET /markets/:tokenId`, `GET /markets/:tokenId/quote`, `POST /orders/intents`, `POST /orders/register`, `GET /orders/:id` (id is the funding outpoint `txid:vout`), `GET /orders?outpoints=` or `?address=`, `POST /orders/:id/cancel/prepare`, `GET /executions/:id`, `GET /orders/:id/executions`, `GET /evidence`, `GET /health` and `GET /network`.

Every input is validated with zod, bodies are limited to 16 KB, writes are rate-limited per IP, and CORS is limited to the web origin. Logs carry no xpubs and no request bodies, and client IPs are truncated.

## Web

The web app sets a strict Content-Security-Policy with a per-request nonce, self-hosts its fonts and loads no third-party scripts. Wallet notifications are client-side, so no user preferences are stored on the server.

## Recovery

See [recovery.md](recovery.md). The recover file uses the same cancel builder as the main app and needs no AtPrice host.
