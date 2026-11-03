# Availability sync service

Accepts availability and price updates for accommodations and delivers them to
Portal Sol. What it guarantees and why it is built this way is in
[`../SPEC.md`](../SPEC.md); this file is about running it.

## Requirements

- Node.js 24 or later (TypeScript runs directly; there is no build step).
- PostgreSQL 18 and Portal Sol, both from the compose file in the repository root:

```bash
docker compose --profile postgres up -d     # from the repository root
```

If port 5432 is taken on your machine, run `POSTGRES_PORT=5434 docker compose --profile postgres up -d`
and point `DATABASE_URL` at that port.

## Install and start

```bash
npm install
npm start                                    # http://localhost:3000
```

Everything is configured through the environment; the defaults match the compose file.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port of this service |
| `DATABASE_URL` | `postgres://sync:sync@localhost:5432/sync` | PostgreSQL connection string |
| `PORTAL_URL` | `http://localhost:4000` | Portal Sol base URL |
| `PORTAL_API_KEY` | `sol-demo-key` | sent as `X-Api-Key` |
| `PORTAL_TIMEOUT_MS` | `5000` | per-attempt timeout of a portal call |
| `PORTAL_RATE_LIMIT_PER_MINUTE` | `30` | call starts allowed per rolling minute |
| `WORKER_CONCURRENCY` | `4` | portal calls in flight at once |
| `WORKER_POLL_MS` | `250` | idle poll interval of the worker |
| `MAX_ATTEMPTS` | `8` | attempts before a job is marked failed |
| `LEASE_SECONDS` | `60` | after this long an in-progress job of a dead process is retried |
| `LOG_LEVEL` | `info` | pino level |

Example against a portal on another host:

```bash
PORTAL_URL=http://portal.example:4000 DATABASE_URL=postgres://sync:sync@localhost:5434/sync npm start
```

## Try it

```bash
curl -s -X POST localhost:3000/updates -H 'content-type: application/json' \
  -d '{"accommodationId":"acc-1003","from":"2026-10-01","to":"2026-10-07","available":true,"pricePerNight":120}'
# → 202 {"updateId":"…","accommodationId":"acc-1003","chunks":1,"status":"pending"}

curl -s localhost:3000/accommodations/acc-1003/sync-status
curl -s localhost:3000/metrics | grep -E '^(sync_|portal_)'
curl -s localhost:3000/health
```

Logs are JSON lines on stdout; pipe through `npx pino-pretty` to read them by eye.

## Tests

```bash
npm test               # unit + integration against a fake portal (needs PostgreSQL)
npm run test:unit      # no I/O
npm run test:fake      # real PostgreSQL, in-process fake portal: deterministic 429 / 503 / timeouts
npm run test:portal    # real PostgreSQL and the real Portal Sol on PORTAL_URL (about a minute, rate-bound)
npm run typecheck
```

Integration tests use `DATABASE_URL` (same default as the service) and **truncate
`updates` and `sync_jobs`** at the start of each file. Do not point them at a database
you care about. The portal tests call the portal's `POST /__admin/reset`.

Each test is named after the requirement it verifies (`SYNC-11: …`), and every commit
names the requirements it implements; `../scripts/trace.sh` prints the mapping.

## Layout

```
src/
  main.ts                 wiring, start-up, graceful shutdown
  config.ts               environment → Config
  db/                     pg pool, SQL migrations applied at start-up
  domain/                 pure logic: dates, validation, status derivation, backoff
  sync/                   repository (SQL), portal client, rate limiter, worker
  http/                   Fastify server and routes
  observability/          pino logger, Prometheus metrics, queue gauges
test/
  unit/                   no I/O
  fake/                   PostgreSQL + in-process fake portal
  portal/                 PostgreSQL + real Portal Sol
  helpers/                fake portal, test pool, worker harness
```
