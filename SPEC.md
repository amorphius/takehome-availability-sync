# SPEC — Availability sync service

Written before coding. It states what will be built, the decisions behind it and how
to tell that it works. It may be refined while building; the first commit is the
starting point.

## 1. Goal

A backend service that accepts availability and price updates for accommodations,
and pushes them to Portal Sol so that:

- no accepted update is ever lost, whether the portal fails, throttles, or the
  service itself restarts;
- the portal's request limit is respected;
- the portal ends up in the state the manager asked for last;
- an operator can tell from logs, metrics and one status endpoint whether
  synchronisation is healthy.

Scope is bounded to 3–4 hours of work. Section 10 lists what is deliberately
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

These numbers drive the defaults in section 8; all are configurable.

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
                               rate limiter (sliding window, shared in-process)
                                        ▼
                               portal client (timeout, classify outcome)
                                        ▼
                       done / retry with backoff / failed  → UPDATE sync_jobs
GET /accommodations/:id/sync-status ◄── reads updates + sync_jobs
GET /metrics  ◄── prom-client registry (+ gauges refreshed from DB every 5 s)
GET /health
```

Why this shape:

- **PostgreSQL as the queue (transactional outbox).** The accepted update and its
  jobs are written in one transaction before the `202` is returned. Durability is
  the database, not the worker, so a crash at any later point loses nothing. No
  extra broker to run or explain.
- **Chunk per 31-day range** because that is the portal's unit of work; each
  chunk is one idempotent `PUT`, so retrying after a timeout is safe.
- **One worker in the same process** keeps the exercise small; the claim query is
  written so several processes could run it safely (section 5.6).

Libraries: Fastify 5 (HTTP, JSON-schema validation), `pg` (plain SQL, no ORM),
`pino` (structured logs), `prom-client` (metrics). Node's built-in test runner.
TypeScript is run directly by Node 24 (type stripping), `tsc` only type-checks.

## 4. Data model

```sql
updates (
  id              uuid primary key,
  accommodation_id text not null,
  from_date       date not null,
  to_date         date not null,
  available       boolean not null,
  price_per_night numeric(10,2) not null,
  received_at     timestamptz not null default now()
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
  last_error_at    timestamptz,
  finished_at      timestamptz
)
-- indexes: (state, next_attempt_at), (accommodation_id, seq), (update_id)
```

`updates` is the manager's intent and is never modified. `sync_jobs` is the work
queue; the update's status is derived from its jobs (section 6).

## 5. Sync semantics

### 5.1 Accepting an update

`POST /updates` validates the body (section 7), splits the range into chunks of
at most 31 days, and inserts the update and its jobs in one transaction. Reply is
`202 Accepted` with the update id. The accommodation's existence is **not** checked
against the portal: that would spend the request budget on every call. An unknown
accommodation surfaces as a `failed` job with `NOT_FOUND` in the sync status.

### 5.2 Ordering: last writer wins

Two updates for the same accommodation may overlap in dates. The portal must end
with the later one. Rule: **jobs of one accommodation are processed strictly in
arrival order, one at a time.** A newer job never starts while an older job of the
same accommodation is pending or in progress, even if the older one is waiting out
a backoff. Different accommodations proceed in parallel.

This is simpler than tracking per-day versions and is correct because arrival
order equals the manager's intent order. Cost: one slow accommodation does not slow
down others, but a failing update blocks later updates for the *same*
accommodation until it succeeds or is marked failed (section 5.4).

### 5.3 Superseding

When a new update arrives, pending (not in-progress) jobs of the same
accommodation whose date range is **fully covered** by the new update are marked
`superseded` and never sent: the new update's chunks will overwrite every day
they would have set. Partially overlapping jobs still run, in order. This drops
wasted portal calls when a manager edits the same week repeatedly.

### 5.4 Outcomes and retries

| Portal response | Classification | Action |
|---|---|---|
| `200` | success | job `done` |
| `429` + `Retry-After` | rate limited | job back to `pending` with `next_attempt_at = now + Retry-After`; **does not count as an attempt**; the limiter pauses *all* portal calls until then |
| `503` | transient | retry with backoff |
| timeout / connection error | transient (request may have been applied; `PUT` is idempotent) | retry with backoff |
| `400`, `404`, `401` | permanent | job `failed` immediately (our bug, bad data, or configuration) |
| `5xx` other | transient | retry with backoff |

Backoff: `min(60 s, 1 s · 2^attempt)` plus up to 50 % random jitter. After
`MAX_ATTEMPTS` (default 8, about 4 minutes of retrying) the job becomes `failed`.
A `failed` job stays visible in status and metrics; it is an alert, not silent
loss. Re-queueing failed jobs is a one-line SQL today and listed as the first
follow-up (section 10).

### 5.5 Respecting the limit

An in-process **sliding-window limiter** mirrors the observed portal rule: at most
`PORTAL_RATE_LIMIT_PER_MINUTE` (default 30) call starts in any 60 s window, with
every attempt counted whatever its outcome. The default is the observed limit;
the limiter's own accuracy, not a safety margin, keeps `429` rare. If the portal
still answers `429`, the limiter pauses every slot until `Retry-After` has passed,
so one `429` never cascades into more. Worker concurrency (default 4) bounds
in-flight requests so a burst of hangs cannot pile up.

### 5.6 Claiming work and crash safety

```sql
UPDATE sync_jobs SET state = 'in_progress', locked_at = now(), attempts = attempts + 1
WHERE id = (
  SELECT j.id FROM sync_jobs j
  WHERE j.state = 'pending' AND j.next_attempt_at <= now()
    AND NOT EXISTS (SELECT 1 FROM sync_jobs o
                    WHERE o.accommodation_id = j.accommodation_id
                      AND o.seq < j.seq AND o.state IN ('pending', 'in_progress'))
  ORDER BY j.seq
  FOR UPDATE SKIP LOCKED
  LIMIT 1)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` lets several slots (or processes) claim concurrently
without double-processing. If the process dies mid-request, the job stays
`in_progress`; on start-up, and every minute, jobs whose `locked_at` is older than
`LEASE_SECONDS` (default 60, well above the request timeout) are returned to
`pending`. Replaying them is safe because the `PUT` is idempotent.

Portal timeout: 5 s per attempt (p95 is under 1 s; hangs observed were far
longer, so 5 s loses almost no good responses).

## 6. HTTP API

All bodies are JSON. Errors use the portal's shape:
`{ "error": { "code": "...", "message": "..." } }`.

### `POST /updates` → `202`

Request as in the assignment. Validation: `accommodationId` non-empty string;
`from`, `to` valid `YYYY-MM-DD` calendar dates with `from <= to` and at most
366 days; `available` boolean; `pricePerNight` finite number `>= 0`. Otherwise
`400 INVALID_BODY` / `INVALID_DATE`.

```json
{ "updateId": "uuid", "accommodationId": "acc-1003", "chunks": 1, "status": "pending" }
```

### `GET /accommodations/:id/sync-status` → `200` | `404`

`404 NOT_FOUND` if the service has never received an update for this id (it knows
nothing about it). Otherwise:

```json
{
  "accommodationId": "acc-1003",
  "status": "synced",
  "jobs": { "pending": 0, "inProgress": 0, "done": 3, "failed": 0, "superseded": 1 },
  "lastSyncedAt": "2026-11-03T18:20:11.512Z",
  "nextAttemptAt": null,
  "lastError": null,
  "updates": [
    { "updateId": "…", "from": "2026-10-01", "to": "2026-10-07", "available": true,
      "pricePerNight": 120, "receivedAt": "…", "status": "synced",
      "chunks": { "total": 1, "done": 1 } }
  ]
}
```

- `status` answers the operator's first question: `synced` (nothing outstanding),
  `pending` (work queued or in flight, including backoff), or `failed` (at least
  one job gave up). `failed` wins over `pending`.
- `lastError` is `{ "code", "message", "at" }` of the most recent failed attempt,
  kept even after a later success so an operator can see what happened.
- `updates` lists the 20 most recent updates, newest first, each with its derived
  status (`pending`, `syncing`, `synced`, `failed`, `superseded`).

Why this shape: the top-level `status` is enough for a dashboard or a
"why is my calendar wrong" ticket; the counts and `nextAttemptAt` say whether
waiting will fix it; `updates` lets support match what the manager did with what
the portal got.

### `GET /metrics` → Prometheus text format. `GET /health` → `200 { "status": "ok" }`
when the database answers.

## 7. Observability

**Logs**: pino JSON to stdout, one line per event, with `updateId`, `jobId`,
`accommodationId`, `attempt`, `outcome`, `portalStatus`, `durationMs`. Request logs
carry a `reqId`. Levels: `info` for accepted updates and job completion, `warn`
for retries and rate-limit pauses, `error` for jobs marked failed.

**Metrics** (`prom-client`, plus default process metrics):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `sync_jobs` | gauge | `state` | jobs per state, refreshed from the DB every 5 s |
| `sync_oldest_pending_job_age_seconds` | gauge | | age of the oldest job not yet done |
| `sync_updates_received_total` | counter | | accepted updates |
| `portal_requests_total` | counter | `outcome` | `success`, `rate_limited`, `unavailable`, `timeout`, `network_error`, `client_error` |
| `portal_request_duration_seconds` | histogram | `outcome` | portal latency |
| `sync_job_retries_total` | counter | `reason` | scheduled retries |
| `sync_jobs_failed_total` | counter | `code` | jobs that gave up |
| `sync_rate_limit_pauses_total` | counter | | `429`s received |
| `sync_portal_paused` | gauge | | 1 while waiting out a `Retry-After` |

**Alerts** an on-call engineer would set:

| Alert | Rule | Why |
|---|---|---|
| Backlog stale | `sync_oldest_pending_job_age_seconds > 600` for 5 min | work is not draining; portal down, worker stuck or limit too low |
| Jobs giving up | `increase(sync_jobs_failed_total[15m]) > 0` | a manager's change did not reach the portal; needs a human |
| Portal error rate | non-success share of `portal_requests_total` (excluding `rate_limited`) `> 40%` over 10 min | baseline is ~17 %; a jump means the portal is degraded |
| Being throttled | `increase(sync_rate_limit_pauses_total[1h]) > 5` | our limiter is miscalibrated or another client shares the key |
| Portal slow | p95 of `portal_request_duration_seconds` `> 3 s` over 10 min | timeouts and retries will follow |
| Worker stalled | `sync_jobs{state="pending"} > 0` and `rate(portal_requests_total[5m]) == 0` | queue has work but nothing is being sent |

## 8. Configuration (environment)

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

Schema migrations are plain SQL files applied at start-up.

## 9. Tests

A few tests that check what matters, not coverage.

Unit (no I/O): range splitting into 31-day chunks (boundaries: 31, 32, 62 days,
month ends); backoff schedule and cap; sliding-window limiter admits exactly N per
window and honours a pause; derived status from job states.

Integration (real PostgreSQL and real Portal Sol, each test starts with
`POST /__admin/reset`):

1. **Accepted means delivered**: post an update, wait, the portal's day-by-day
   state equals the request.
2. **Survives restart**: post updates, stop the worker mid-way, start a new one;
   every job ends `done` and the portal state is right.
3. **Respects the limit**: post more work than one minute allows; the admin log
   contains no `429`, and all jobs end `done`.
4. **Transient failures are retried**: with the portal's natural `503` rate, the
   admin log shows `503`s and every job still ends `done` (the request log proves
   the retries).
5. **Last writer wins**: two overlapping updates posted back to back; the portal
   shows the second one's values on the overlap.

Integration tests are rate-bound by the portal (30 calls/min), so they use few,
small updates and run in about a minute.

## 10. Out of scope, and next

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
5. Authentication, deployment, dashboards.

## 11. Acceptance criteria

- [ ] `POST /updates` with a valid body returns `202` and the row exists in
      PostgreSQL before the response is sent.
- [ ] Invalid bodies return `400` with the documented error shape.
- [ ] Every accepted update reaches the portal: after the queue drains, the
      portal's day-by-day state matches the latest update for every day touched.
- [ ] Killing and restarting the service with jobs pending or in progress loses
      nothing and sends no wrong state.
- [ ] Under sustained load the portal's admin log shows no `429` from this
      service; if one occurs, no request is sent before `Retry-After` elapses.
- [ ] `503` and timeouts are retried with backoff; a job that exhausts attempts
      is `failed`, visible in sync status and in `sync_jobs_failed_total`.
- [ ] `GET /accommodations/:id/sync-status` reflects the states above within
      one poll interval.
- [ ] `GET /metrics` exposes every metric in section 7 with live values.
- [ ] Logs are JSON lines with the fields in section 7.
- [ ] `README.md` in `service/` explains install, run, test and configuration.
