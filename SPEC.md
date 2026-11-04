# SPEC — Availability sync service

Written before coding. Sections 1–4 say what the system is and why it is shaped
this way; section 5 lists the decisions; section 6 is the list of atomic
requirements that the commits implement. Every commit that implements behaviour
names the requirement IDs it covers in its subject, for example
`feat(sync): schedule retry from Retry-After on 429 [SYNC-11]`, and carries the
test that verifies them. `scripts/trace.sh` (OPS-04) reports which commits and
tests cover each ID.

IDs are stable: a requirement that is dropped is marked *withdrawn*, never
renumbered.

## 1. Goal

A backend service that accepts availability and price updates for accommodations
and pushes them to Portal Sol so that:

- no accepted update is ever lost, whether the portal fails, throttles, or the
  service restarts;
- the portal's request limit is respected;
- the portal ends up in the state the manager asked for last;
- an operator can tell from logs, metrics and one status endpoint whether
  synchronisation is healthy.

Scope is bounded to 3–4 hours of work. Section 9 lists what is deliberately
left out.

## 2. Observed portal behaviour

`API.md` documents the kinds of failure but not the numbers. Before designing, the
portal was probed for 75 seconds with sequential `GET` requests (3 s client
timeout) and the admin request log was read. Observed:

| Behaviour | Observation |
|---|---|
| Request limit | about **30 requests per rolling 60 s**. Requests that end in `503` or in a client-side timeout **count** towards the limit; rejected `429`s do not. |
| `429` | `Retry-After` is the number of seconds until the oldest counted request leaves the window (observed 1 to 42 s). |
| `503 UNAVAILABLE` | roughly **1 in 6** requests, independent of the request. |
| Latency of `200` | min 140 ms, p50 ≈ 420 ms, p95 ≈ 780 ms. |
| Hangs | a few percent of requests do not answer within 3 s. `API.md` warns a timed-out request may still have been applied. |
| Range limit | 31 days inclusive per `PUT`; longer ranges are `400 RANGE_TOO_LARGE`. |
| Idempotency | `PUT` repeats are safe (documented). |

These numbers drive the defaults in section 7; all are configurable.

## 3. Architecture

Node.js 24 + TypeScript, one process, PostgreSQL as the only state.

```
POST /updates ──► validate ──► INSERT update + sync_jobs (one txn) ──► 202
                                        │
                                        ▼  (PostgreSQL = durable queue)
                              worker loop (N concurrent slots)
                                        │ claim job: FOR UPDATE SKIP LOCKED,
                                        │ FIFO per accommodation
                                        ▼
                               rate limiter (sliding window, in-process)
                                        ▼
                               portal client (timeout, classify outcome)
                                        ▼
                       done / retry with backoff / failed  → UPDATE sync_jobs
GET /accommodations/:id/sync-status ◄── reads updates + sync_jobs
GET /metrics  ◄── prom-client registry (+ gauges refreshed from DB every 5 s)
GET /health
```

## 4. Data model

```sql
updates (
  id               uuid primary key,
  accommodation_id text not null,
  from_date        date not null,
  to_date          date not null,
  available        boolean not null,
  price_per_night  numeric(10,2) not null,
  received_at      timestamptz not null default now()
)

sync_jobs (
  id               uuid primary key,
  seq              bigserial,                 -- global arrival order
  update_id        uuid not null references updates(id),
  accommodation_id text not null,
  from_date        date not null,             -- chunk, at most 31 days
  to_date          date not null,
  available        boolean not null,
  price_per_night  numeric(10,2) not null,
  state            text not null,             -- pending | in_progress | done | failed | superseded
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  locked_at        timestamptz,
  last_error_code  text,
  last_error_message text,
  last_error_at    timestamptz,
  finished_at      timestamptz
)
-- indexes: (state, next_attempt_at), (accommodation_id, seq), (update_id)
```

`updates` is the manager's intent and is never modified. `sync_jobs` is the work
queue; an update's status is derived from its jobs (API-05).

## 5. Decisions

| ID | Decision | Why, and what it costs |
|---|---|---|
| D-01 | PostgreSQL is the queue (transactional outbox); no broker. | The update and its jobs are committed before the `202`, so a crash at any later point loses nothing. One less system to run and explain. |
| D-02 | One job per 31-day chunk, one idempotent `PUT` per job. | The portal's unit of work. Idempotency makes replay after a timeout safe without read-back. |
| D-03 | Jobs of one accommodation run strictly in arrival order, one at a time; accommodations run in parallel. | Guarantees last writer wins on overlapping dates without per-day versioning. Cost: a failing update blocks later updates of the *same* accommodation until it succeeds or gives up. |
| D-04 | A new update supersedes pending jobs of the same accommodation whose range it fully covers. | Drops wasted calls when a manager edits the same week repeatedly. Partial overlaps still run, in order. |
| D-05 | Accommodation existence is not checked against the portal at accept time. | A check would spend the request budget on every call. An unknown id surfaces as a `failed` job with `NOT_FOUND`. |
| D-06 | Rate limiting is an in-process sliding window set to the observed limit; a `429` pauses every slot until `Retry-After`. | Mirrors the portal's rule exactly, so `429` stays the exception. One `429` never cascades. Cost: two replicas would need a shared limiter (section 9). |
| D-07 | Transient failures retry with capped exponential backoff; after `MAX_ATTEMPTS` a job is `failed` and stays visible. | Bounded retry keeps a dead accommodation from blocking forever; a failed job is an alert, never silent loss. |
| D-08 | Per-attempt portal timeout of 5 s. | p95 is under 1 s; observed hangs were far longer. 5 s loses almost no good responses. |
| D-09 | Sync status gives one top-level `status`, job counts, `nextAttemptAt`, `lastError`, and the 20 latest updates. | The first field answers "is it synced"; the counts and times say whether waiting will fix it; the list lets support match what the manager did with what the portal got. |
| D-10 | Fastify 5, `pg` with plain SQL, `pino`, `prom-client`; Node's built-in test runner; TypeScript run directly by Node 24, `tsc` only type-checks. | Few dependencies, no build step, nothing a reviewer has to learn. |
| D-11 | Single process, but the claim query is written for several (`FOR UPDATE SKIP LOCKED`) and stale leases are reclaimed. | Correct today, scales out later without redesign. |
| D-12 | Deterministic failure tests use an in-process fake portal; the real Portal Sol is used for end-to-end tests only. | The real portal's failures are random and rate-bound; a fake makes `429`, `503` and timeout behaviour testable in milliseconds. |
| D-13 | Every value that crosses the boundary is bounded before use: client bodies (size, id, price), portal answers (`Retry-After`, body size), the environment (no secret defaults in production). A shared API key guards the data endpoints until a gateway does. | Added after a security review of the first version (SEC-01..12). None of it changes the sync behaviour; each is a cap or a check at the edge, so a hostile client or a broken portal costs bounded memory, CPU and queue space. The key is a stop-gap: it keeps the service closed by default, not a substitute for real identity. |

## 6. Requirements

"Verified by" names the test kind: **unit** (no I/O), **fake** (in-process fake
portal + real PostgreSQL), **portal** (real Portal Sol + real PostgreSQL),
**manual** (a documented `curl`).

### DATA — persistence

| ID | Requirement | Verified by |
|---|---|---|
| DATA-01 | The schema of section 4 is created by SQL migration files applied at start-up; starting twice is harmless. | fake |
| DATA-02 | An accepted update and all its jobs are written in one transaction that commits before the `202` is sent. | fake |

### API — HTTP interface

| ID | Requirement | Verified by |
|---|---|---|
| API-01 | `POST /updates` accepts `{accommodationId, from, to, available, pricePerNight}` and answers `202 {updateId, accommodationId, chunks, status: "pending"}`. | fake |
| API-02 | Invalid input is rejected with `{error: {code, message}}`: `400 INVALID_BODY` for a non-object body, missing, unknown or wrongly typed fields, empty `accommodationId`, or `pricePerNight` not a finite number `>= 0`; `400 INVALID_DATE` for a malformed or non-existent date or `to` before `from`; `400 RANGE_TOO_LARGE` above 366 days. | unit |
| API-03 | `GET /accommodations/:id/sync-status` answers `404 NOT_FOUND` when no update was ever received for that id. | fake |
| API-04 | Otherwise it answers `200` with `accommodationId`, `status`, `jobs {pending, inProgress, done, failed, superseded}`, `lastSyncedAt`, `nextAttemptAt`, `lastError {code, at}` or `null` (the message was removed by SEC-09), and `updates` (20 newest first, each with `updateId, from, to, available, pricePerNight, receivedAt, status, chunks {total, done}`). | fake |
| API-05 | Status derivation: an update is `superseded` if all jobs are superseded, `failed` if any job failed, `syncing` if any is in progress, `synced` if every job is done or superseded, else `pending`. The accommodation is `failed` if any update is failed, `pending` if any is pending or syncing, else `synced`. | unit |
| API-06 | `GET /health` answers `200 {status: "ok"}` when the database answers a query and `503` otherwise. | manual |

### SYNC — delivering updates to the portal

| ID | Requirement | Verified by |
|---|---|---|
| SYNC-01 | A date range is split into contiguous chunks of at most 31 days inclusive that cover exactly the range. | unit |
| SYNC-02 | The worker claims the pending job with the lowest `seq` whose `next_attempt_at <= now()`, using `FOR UPDATE SKIP LOCKED`, and marks it `in_progress` with `locked_at` and `attempts + 1` in the same statement. | fake |
| SYNC-03 | A job is not claimed while an older job (`seq` lower) of the same accommodation is `pending` or `in_progress`. | fake |
| SYNC-04 | When an update is accepted, pending (not in-progress) jobs of the same accommodation whose range lies within the new update's range are marked `superseded`. | fake |
| SYNC-05 | The portal client sends `PUT /api/v1/accommodations/:id/availability` with `X-Api-Key` and a JSON body, aborts after `PORTAL_TIMEOUT_MS`, and classifies the result as `success`, `rate_limited`, `unavailable` (503 and other 5xx), `timeout`, `network_error` or `client_error` (400, 401, 404). | unit |
| SYNC-06 | On `success` the job becomes `done` with `finished_at`. | fake |
| SYNC-07 | On `unavailable`, `timeout` or `network_error` the job returns to `pending` with `next_attempt_at = now() + backoff(attempts)` and the error recorded in `last_error_*`. | fake |
| SYNC-08 | `backoff(n) = min(60 s, 1 s · 2^n)` plus random jitter of up to 50 %. | unit |
| SYNC-09 | A transient failure on attempt `MAX_ATTEMPTS` makes the job `failed` with `finished_at` and the last error kept. | fake |
| SYNC-10 | On `client_error` the job becomes `failed` immediately, with the portal's error code and message. | fake |
| SYNC-11 | On `rate_limited` the job returns to `pending` with `next_attempt_at = now() + Retry-After`, the attempt is not counted, and no portal call is started by any slot until that time. | fake |
| SYNC-12 | The limiter allows at most `PORTAL_RATE_LIMIT_PER_MINUTE` call starts in any rolling 60 s window, counting every attempt whatever its outcome. | unit |
| SYNC-13 | At most `WORKER_CONCURRENCY` portal calls are in flight at once. | unit |
| SYNC-14 | At start-up and every 60 s, `in_progress` jobs whose `locked_at` is older than `LEASE_SECONDS` are returned to `pending`. | fake |
| SYNC-15 | After the queue drains, the portal's day-by-day state equals the latest accepted update for every day touched, including when two updates overlap. | portal |
| SYNC-16 | Under a backlog larger than one minute's budget, the portal's admin log shows no `429` from this service. | portal |

### OBS — observability

| ID | Requirement | Verified by |
|---|---|---|
| OBS-01 | Logs are JSON lines (pino) with `level`, `time`, `msg` and, where applicable, `reqId`, `updateId`, `jobId`, `accommodationId`, `attempt`, `outcome`, `portalStatus`, `durationMs`. Accepted updates and completed jobs log at `info`, retries and rate-limit pauses at `warn`, jobs marked failed at `error`. | manual |
| OBS-02 | `GET /metrics` serves the Prometheus text format including Node's default process metrics. | fake |
| OBS-03 | `sync_jobs{state}` (gauge) and `sync_oldest_pending_job_age_seconds` (gauge) are refreshed from the database every 5 s. | fake |
| OBS-04 | `portal_requests_total{outcome}` (counter) and `portal_request_duration_seconds{outcome}` (histogram) are recorded for every portal attempt. | fake |
| OBS-05 | `sync_updates_received_total`, `sync_job_retries_total{reason}`, `sync_jobs_failed_total{code}`, `sync_rate_limit_pauses_total` (counters) and `sync_portal_paused` (gauge, 1 while waiting out a `Retry-After`) are recorded. | fake |

### OPS — running it

| ID | Requirement | Verified by |
|---|---|---|
| OPS-01 | Configuration is read from the environment with the defaults of section 7; an invalid value stops start-up with a message naming the variable. | unit |
| OPS-02 | On `SIGTERM`/`SIGINT` the service stops claiming jobs, waits up to `PORTAL_TIMEOUT_MS` for in-flight calls, closes the database pool and exits 0. | manual |
| OPS-03 | `service/README.md` explains how to install, start, test and configure the service, including the portal URL. | manual |
| OPS-04 | `scripts/trace.sh` prints, for every requirement ID in this file, the commits and test files that mention it, and lists IDs with neither. | manual |

### SEC — hardening (D-13)

| ID | Requirement | Verified by |
|---|---|---|
| SEC-01 | When `API_KEY` is set, `POST /updates`, `GET /accommodations/:id/sync-status` and `GET /metrics` require the header `X-Api-Key` equal to it (compared in constant time) and answer `401 UNAUTHORIZED` otherwise; `GET /health` never requires it. When `API_KEY` is unset nothing is required. The server listens on `HOST`, default `127.0.0.1`. | fake |
| SEC-02 | A `Retry-After` from the portal is clamped to `PORTAL_MAX_RETRY_AFTER_SECONDS`; the limiter's sleep never exceeds the platform timer maximum, so a pause of any length costs no CPU. | unit |
| SEC-03 | `POST /updates` answers `429 RATE_LIMITED` with `Retry-After` beyond `UPDATES_RATE_LIMIT_PER_MINUTE` requests per client address in a rolling minute, `429 QUEUE_FULL` when the accommodation already has `MAX_PENDING_JOBS_PER_ACCOMMODATION` pending or in-progress jobs, and `503 QUEUE_FULL` when `MAX_PENDING_JOBS` jobs are pending or in progress overall; nothing is written in those cases. | fake |
| SEC-04 | `accommodationId` is at most 64 characters from `A-Z a-z 0-9 . _ -`; anything else is `400 INVALID_BODY`. | unit |
| SEC-05 | `pricePerNight` is at most `99999999.99` with at most two decimals; anything else is `400 INVALID_BODY`. | unit |
| SEC-06 | The portal client reads at most 64 KiB of a response body; a longer body is cut there and the response is classified by its status as usual. | unit |
| SEC-07 | The HTTP server accepts bodies up to 16 KiB (`413 BODY_TOO_LARGE`), ends a request not completed within 10 s and closes a connection idle for 30 s. | fake |
| SEC-08 | With `NODE_ENV=production`, `DATABASE_URL`, `PORTAL_API_KEY` and `API_KEY` have no defaults; start-up fails naming the missing variable. | unit |
| SEC-09 | The status endpoint exposes `lastError {code, at}` only; the portal's message stays in the database and the logs. | fake |
| SEC-10 | `GET /metrics` is behind the API key of SEC-01; `GET /health` answers only `status` and a fixed `reason`. | fake |
| SEC-11 | Migrations run under a transaction-scoped advisory lock, so a failed migration releases the lock with its rollback and a later start-up does not hang. | fake |
| SEC-12 | An `Idempotency-Key` header (1–128 characters) on `POST /updates` makes a repeated request with the same key answer `202` with the original `updateId` and `chunks`, creating nothing new. | fake |

## 7. Configuration (environment)

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `DATABASE_URL` | `postgres://sync:sync@localhost:5432/sync` |
| `PORTAL_URL` | `http://localhost:4000` |
| `PORTAL_API_KEY` | `sol-demo-key` |
| `PORTAL_TIMEOUT_MS` | `5000` |
| `PORTAL_RATE_LIMIT_PER_MINUTE` | `30` |
| `WORKER_CONCURRENCY` | `4` |
| `WORKER_POLL_MS` | `250` |
| `MAX_ATTEMPTS` | `8` |
| `LEASE_SECONDS` | `60` |
| `LOG_LEVEL` | `info` |
| `HOST` | `127.0.0.1` (SEC-01; use `0.0.0.0` in a container) |
| `API_KEY` | unset: endpoints open (SEC-01); required with `NODE_ENV=production` (SEC-08) |
| `NODE_ENV` | unset; `production` removes the secret defaults (SEC-08) |
| `PORTAL_MAX_RETRY_AFTER_SECONDS` | `300` (SEC-02) |
| `UPDATES_RATE_LIMIT_PER_MINUTE` | `600` per client address (SEC-03) |
| `MAX_PENDING_JOBS_PER_ACCOMMODATION` | `50` (SEC-03) |
| `MAX_PENDING_JOBS` | `10000` (SEC-03) |

## 8. Alerts an on-call engineer would set

| Alert | Rule | Why |
|---|---|---|
| Backlog stale | `sync_oldest_pending_job_age_seconds > 600` for 5 min | work is not draining: portal down, worker stuck or limit too low |
| Jobs giving up | `increase(sync_jobs_failed_total[15m]) > 0` | a manager's change did not reach the portal; needs a human |
| Portal error rate | non-success share of `portal_requests_total` (excluding `rate_limited`) `> 40%` over 10 min | baseline is ~17 %; a jump means the portal is degraded |
| Being throttled | `increase(sync_rate_limit_pauses_total[1h]) > 5` | our limiter is miscalibrated or another client shares the key |
| Portal slow | p95 of `portal_request_duration_seconds > 3 s` over 10 min | timeouts and retries will follow |
| Worker stalled | `sync_jobs{state="pending"} > 0` and `rate(portal_requests_total[5m]) == 0` | queue has work but nothing is being sent |

## 9. Out of scope, and next

Left out on purpose, in the order they would be done next:

1. **Re-queue endpoint** for failed jobs (`POST /accommodations/:id/retry`); today
   it is an `UPDATE` statement.
2. **Multi-instance limiter**: the sliding window is in-process. Two replicas would
   need it in PostgreSQL (advisory lock + table) or Redis.
3. **Read-back verification**: a `GET` of the portal after each chunk would prove
   the final state but doubles the request budget; the idempotent `PUT` plus
   `200` is taken as proof instead.
4. **Day-level merge** of overlapping updates into minimal `PUT`s; FIFO plus
   superseding covers the common case.
5. Identity beyond one shared API key (per-client keys, a gateway), deployment,
   dashboards.
