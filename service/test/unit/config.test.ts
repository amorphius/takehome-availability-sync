import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../../src/config.ts";

test("OPS-01: defaults apply when the environment is empty", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.apiKey, undefined);
  assert.equal(config.databaseUrl, "postgres://sync:sync@localhost:5432/sync");
  assert.equal(config.portalUrl, "http://localhost:4000");
  assert.equal(config.portalApiKey, "sol-demo-key");
  assert.equal(config.portalTimeoutMs, 5000);
  assert.equal(config.portalRateLimitPerMinute, 30);
  assert.equal(config.portalMaxRetryAfterSeconds, 300);
  assert.equal(config.workerConcurrency, 4);
  assert.equal(config.workerPollMs, 250);
  assert.equal(config.maxAttempts, 8);
  assert.equal(config.leaseSeconds, 60);
  assert.equal(config.logLevel, "info");
});

test("OPS-01: values are read from the environment", () => {
  const config = loadConfig({ PORT: "8080", HOST: "0.0.0.0", API_KEY: "k", PORTAL_URL: "http://portal:4000/", MAX_ATTEMPTS: "3", LOG_LEVEL: "debug" });
  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.apiKey, "k");
  assert.equal(config.portalUrl, "http://portal:4000");
  assert.equal(config.maxAttempts, 3);
  assert.equal(config.logLevel, "debug");
});

test("OPS-01: an invalid value fails with a message naming the variable", () => {
  assert.throws(() => loadConfig({ PORTAL_TIMEOUT_MS: "soon" }), (e: unknown) => e instanceof ConfigError && /PORTAL_TIMEOUT_MS/.test((e as Error).message));
  assert.throws(() => loadConfig({ WORKER_CONCURRENCY: "0" }), /WORKER_CONCURRENCY/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
  assert.throws(() => loadConfig({ LOG_LEVEL: "loud" }), /LOG_LEVEL/);
});
