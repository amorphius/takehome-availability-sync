import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import type { WorkerObserver } from "../sync/worker.ts";
import type { OutcomeKind } from "../sync/portalClient.ts";

export interface Metrics {
  registry: Registry;
  /** OBS-05: accepted updates. */
  updatesReceived: Counter;
  /** OBS-04 / OBS-05: hooks the worker calls. */
  observer: WorkerObserver;
}

/** OBS-02 (default process metrics), OBS-04 and OBS-05 (portal calls, retries, failures, pauses). */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const updatesReceived = new Counter({
    name: "sync_updates_received_total",
    help: "Updates accepted by POST /updates",
    registers: [registry],
  });
  const portalRequests = new Counter<"outcome">({
    name: "portal_requests_total",
    help: "Portal calls by outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const portalDuration = new Histogram<"outcome">({
    name: "portal_request_duration_seconds",
    help: "Portal call latency by outcome",
    labelNames: ["outcome"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });
  const retries = new Counter<"reason">({
    name: "sync_job_retries_total",
    help: "Jobs rescheduled after a transient failure, by reason",
    labelNames: ["reason"],
    registers: [registry],
  });
  const failed = new Counter<"code">({
    name: "sync_jobs_failed_total",
    help: "Jobs that gave up, by last error code",
    labelNames: ["code"],
    registers: [registry],
  });
  const pauses = new Counter({
    name: "sync_rate_limit_pauses_total",
    help: "429 responses received from the portal",
    registers: [registry],
  });
  const paused = new Gauge({ name: "sync_portal_paused", help: "1 while waiting out a Retry-After", registers: [registry] });

  // Every outcome label exists from the start so rate() queries never see a missing series.
  const outcomes: OutcomeKind[] = ["success", "rate_limited", "unavailable", "timeout", "network_error", "client_error"];
  for (const outcome of outcomes) portalRequests.labels(outcome).inc(0);

  const observer: WorkerObserver = {
    portalResult: ({ outcome, durationMs }) => {
      portalRequests.labels(outcome.kind).inc();
      portalDuration.labels(outcome.kind).observe(durationMs / 1000);
    },
    retry: (reason) => retries.labels(reason).inc(),
    failed: (code) => failed.labels(code).inc(),
    paused: () => {
      pauses.inc();
      paused.set(1);
    },
    resumed: () => paused.set(0),
  };

  return { registry, updatesReceived, observer };
}
