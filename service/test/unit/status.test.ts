import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveUpdateStatus, deriveAccommodationStatus } from "../../src/domain/status.ts";

test("API-05: update status from job states", () => {
  assert.equal(deriveUpdateStatus(["pending"]), "pending");
  assert.equal(deriveUpdateStatus(["done", "pending"]), "pending");
  assert.equal(deriveUpdateStatus(["done", "in_progress"]), "syncing");
  assert.equal(deriveUpdateStatus(["done", "done"]), "synced");
  assert.equal(deriveUpdateStatus(["done", "superseded"]), "synced");
  assert.equal(deriveUpdateStatus(["superseded", "superseded"]), "superseded");
  assert.equal(deriveUpdateStatus(["done", "failed", "pending"]), "failed", "failed wins over pending");
  assert.equal(deriveUpdateStatus(["in_progress", "failed"]), "failed", "failed wins over syncing");
  assert.equal(deriveUpdateStatus([]), "pending", "an update without jobs is not synced");
});

test("API-05: accommodation status from update statuses", () => {
  assert.equal(deriveAccommodationStatus([]), "synced");
  assert.equal(deriveAccommodationStatus(["synced", "superseded"]), "synced");
  assert.equal(deriveAccommodationStatus(["synced", "pending"]), "pending");
  assert.equal(deriveAccommodationStatus(["syncing"]), "pending");
  assert.equal(deriveAccommodationStatus(["pending", "failed", "synced"]), "failed");
});
