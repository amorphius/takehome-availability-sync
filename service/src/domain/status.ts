import type { JobState } from "../sync/repository.ts";

export type UpdateStatus = "pending" | "syncing" | "synced" | "failed" | "superseded";
export type AccommodationStatus = "synced" | "pending" | "failed";

/** API-05: an update's status from the states of its jobs. */
export function deriveUpdateStatus(states: readonly JobState[]): UpdateStatus {
  if (states.length > 0 && states.every((s) => s === "superseded")) return "superseded";
  if (states.some((s) => s === "failed")) return "failed";
  if (states.some((s) => s === "in_progress")) return "syncing";
  if (states.length > 0 && states.every((s) => s === "done" || s === "superseded")) return "synced";
  return "pending";
}

/** API-05: the accommodation's status from its updates'. `failed` wins, then `pending`. */
export function deriveAccommodationStatus(statuses: readonly UpdateStatus[]): AccommodationStatus {
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "pending" || s === "syncing")) return "pending";
  return "synced";
}
