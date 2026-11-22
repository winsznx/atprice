# Runbook

## Topology

- Web: Next.js on Vercel at https://atprice.cash.
- API and keeper: two containers from one image ([`apps/server/Dockerfile`](../apps/server/Dockerfile)), plus Postgres, on one VPS with Docker Compose. The API is public at https://api.atprice.cash.
- Postgres has no published port. Only the `migrate`, `api` and `keeper` containers reach it.

The keeper holds no key and needs no funds. Deploy secrets are database and Electrum settings only, kept in an env file outside the repo.

## Server deploy

Two Compose files are provided:

- [`deploy/docker-compose.kordaen.yml`](../deploy/docker-compose.kordaen.yml): for a host that already runs a shared Caddy on ports 80 and 443 on the external Docker network `compose_default`. The API joins that network under the alias `atprice-api`, and the shared Caddyfile proxies the API domain to `atprice-api:4000`.
- [`deploy/docker-compose.yml`](../deploy/docker-compose.yml): self-contained, with its own Caddy ([`deploy/Caddyfile`](../deploy/Caddyfile)) for TLS, a 16 KB request body limit and the single trusted proxy.

Create the env file outside the repo (the Compose files' usage line uses `/etc/atprice/server.env`):

| Variable                   | Required                 | Notes                                                                                                                                           |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATPRICE_NETWORK`          | yes                      | `mainnet` or `chipnet`                                                                                                                          |
| `POSTGRES_PASSWORD`        | yes                      | used for the Postgres container and `DATABASE_URL`                                                                                              |
| `WEB_ORIGIN`               | yes                      | web app origin, for CORS                                                                                                                        |
| `API_DOMAIN`               | self-contained file only | public API host name for Caddy                                                                                                                  |
| `ELECTRUM_SERVERS`         | no                       | comma-separated `host:port` TLS servers; at least two distinct hosts, because the health evaluator must read a server the keeper is not reading |
| `KEEPER_SWEEP_INTERVAL_MS` | no                       | default 30000                                                                                                                                   |
| `HEALTH_EVAL_INTERVAL_MS`  | no                       | default 30000                                                                                                                                   |
| `TRUST_PROXY`              | no                       | the proxy address or subnet Fastify trusts for client IPs                                                                                       |
| `ATPRICE_COHORT`           | no                       | `developer_test`, `pilot` (default) or `production`                                                                                             |
| `LOG_LEVEL`                | no                       | default `info`                                                                                                                                  |

Deploy or update from the repository root on the VPS:

```sh
git pull
docker compose -f deploy/docker-compose.kordaen.yml --env-file /etc/atprice/server.env up -d --build
```

Compose builds the image, runs `migrate` (`node dist/migrate-cli.js`) once Postgres is healthy, and starts `keeper` and `api` only after the migration succeeds. Every service restarts `unless-stopped`. Logs use the `json-file` driver capped at 7 files of 20 MB.

Check it:

```sh
docker compose -f deploy/docker-compose.kordaen.yml ps
curl -s https://api.atprice.cash/api/v1/network
curl -s https://api.atprice.cash/api/v1/health
```

The API container's own healthcheck calls `/api/v1/network` every 30 s.

## Web deploy

The Vercel project deploys a prebuilt output, built locally from `apps/web`:

```sh
pnpm install --frozen-lockfile
pnpm build                  # builds apps/recover first; /recover is prerendered from its manifest
# from the repository root; the Vercel project's root directory is apps/web
vercel build --prod
vercel deploy --prebuilt --prod
```

Web env, set in the Vercel project for production ([`apps/web/.env.example`](../apps/web/.env.example)):

| Variable                                                                                 | Required | Notes                                           |
| ---------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| `NEXT_PUBLIC_ATPRICE_NETWORK`                                                            | yes      | must match the API's `ATPRICE_NETWORK`          |
| `NEXT_PUBLIC_API_URL`                                                                    | yes      | API origin, https; the client appends `/api/v1` |
| `NEXT_PUBLIC_BUILD_SHA`                                                                  | no       | defaults to the Vercel or local git commit      |
| `NEXT_PUBLIC_BLAZE_DECK_URL`, `NEXT_PUBLIC_SOURCE_REPO_URL`, `NEXT_PUBLIC_EMBER_ADDRESS` | no       | BLAZE banner; an invalid value fails the build  |

Env validation runs during `next build`, so a missing or invalid value fails the build with a named error such as `ENV_API_URL_MISSING`. A missing or altered recover file also fails the build.

## Health

`GET /api/v1/health` returns 200 with `status: ok` only when every check passes. Otherwise it returns 503 with `status: degraded` and the failing reasons ([`apps/server/src/health/judge.ts`](../apps/server/src/health/judge.ts)):

| Reason                     | Fails when                                                                                                                                                                                                    | First thing to check                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `tip_lag`                  | the keeper's tip is more than 2 blocks behind the tip the evaluator reads from a second Electrum server, the keeper and evaluator read the same server, or no header for 60 min (mainnet) or 10 min (chipnet) | keeper logs for Electrum disconnects; `ELECTRUM_SERVERS` has two distinct hosts |
| `sweep_stale`              | the last keeper sweep finished more than 2 sweep intervals ago                                                                                                                                                | is the keeper container running; `docker compose logs keeper`                   |
| `pool_data_stale`          | any market's pool data is older than 2 minutes                                                                                                                                                                | Rostrum and Cauldron indexer reachability from the VPS                          |
| `subscriptions_incomplete` | not every open, pending and live-intent address is subscribed, or the fact is older than two sweep intervals                                                                                                  | keeper logs around the last reconnect                                           |
| `executable_unfilled`      | the evaluator found an order executable longer than `2 × KEEPER_SWEEP_INTERVAL_MS + HEALTH_EVAL_INTERVAL_MS` while its outpoint is still unspent                                                              | `GET /api/v1/orders/:id/executions` for that order's attempts and reasons       |
| `vm_rejected`              | an open order has a `vm_rejected` attempt                                                                                                                                                                     | builder defect: needs a code fix                                                |
| `quote_disagreement`       | the keeper's quote and the evaluator's independent quote differ by one unit or more on the same pool outpoint                                                                                                 | maths defect in one of the two paths: needs a code fix                          |
| `evaluator_unavailable`    | the evaluator has not completed a run, or its last run failed                                                                                                                                                 | API logs; the evaluator's Electrum connection                                   |

The keeper cannot write the evaluator's state, and failed attempts do not reset `executable_unfilled`, so the keeper cannot make itself look healthy.

`GET /api/v1/network` also reports the keeper's facts, open orders, orders in `RECONCILIATION_REQUIRED`, unexpected spends, the executable backlog and its oldest age, confirmed keeper fills, and attempt outcomes over the last hour.

## Alerts

Watch these conditions. `/api/v1/health` and `/api/v1/network` expose all four, so any uptime or log monitor can poll them:

- Health 503 for more than 5 minutes.
- Executable backlog older than 10 minutes.
- Any `vm_rejected` attempt.
- Any order in `RECONCILIATION_REQUIRED`.

## Outage response

User funds are never at risk from an outage: orders sit in their own covenants, and only a fill that pays the owner or a cancel that refunds the owner can spend them. An outage only delays fills.

API or keeper down:

1. `docker compose -f deploy/docker-compose.kordaen.yml ps` and `logs --tail 200 api keeper`.
2. Restart the failed service: `docker compose -f deploy/docker-compose.kordaen.yml restart keeper`. On boot the keeper reloads orders and attempts from Postgres, resubscribes, backfills history and reconciles in-flight attempts, so nothing is lost while it was down.
3. Confirm `/api/v1/health` returns 200.

Electrum server down or lagging: set `ELECTRUM_SERVERS` to two healthy distinct hosts in the env file and run `up -d` again. The keeper fails over within its list and resubscribes after every reconnect.

Postgres down: the keeper and API stop serving until it is back. Restart it with `docker compose ... restart postgres`. Data lives in the `postgres-data` volume.

Long outage, or AtPrice shut down: users cancel with the recover file or `pnpm recover`, which need no AtPrice host ([recovery.md](recovery.md)). Point users to it on the site and in the repository.

Bad release: check out the previous commit on the VPS and run `up -d --build` again. Migrations are plain SQL with no down scripts, so check [`apps/server/migrations`](../apps/server/migrations) before rolling back across a schema change.
