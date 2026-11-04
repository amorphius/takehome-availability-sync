import { parseDate, daysInclusive } from "./dates.ts";

export const MAX_UPDATE_DAYS = 366;
/** SEC-04: ids are stored, indexed, logged and put in a URL; keep them short and plain. */
export const MAX_ACCOMMODATION_ID_LENGTH = 64;
const ACCOMMODATION_ID_RE = /^[A-Za-z0-9._-]+$/;
/** SEC-05: the column is numeric(10,2); anything beyond it would fail inside the transaction as a 500. */
export const MAX_PRICE_PER_NIGHT = 99_999_999.99;

export interface UpdateRequest {
  accommodationId: string;
  from: string;
  to: string;
  available: boolean;
  pricePerNight: number;
}

/** The error shape shared with the portal: `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FIELDS = ["accommodationId", "from", "to", "available", "pricePerNight"] as const;

/** API-02: validates a POST /updates body; throws ApiError with the documented code. */
export function parseUpdateRequest(body: unknown): UpdateRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", "Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw new ApiError(400, "INVALID_BODY", `Unknown field "${key}". Allowed: ${FIELDS.join(", ")}`);
    }
  }
  for (const key of FIELDS) {
    if (!(key in record)) throw new ApiError(400, "INVALID_BODY", `Missing field "${key}"`);
  }
  const { accommodationId, from, to, available, pricePerNight } = record;
  if (typeof accommodationId !== "string" || accommodationId.trim() === "") {
    throw new ApiError(400, "INVALID_BODY", '"accommodationId" must be a non-empty string');
  }
  if (accommodationId.length > MAX_ACCOMMODATION_ID_LENGTH || !ACCOMMODATION_ID_RE.test(accommodationId)) {
    throw new ApiError(400, "INVALID_BODY", `"accommodationId" must be at most ${MAX_ACCOMMODATION_ID_LENGTH} characters of letters, digits, ".", "_" or "-"`);
  }
  if (typeof available !== "boolean") throw new ApiError(400, "INVALID_BODY", '"available" must be a boolean');
  if (typeof pricePerNight !== "number" || !Number.isFinite(pricePerNight) || pricePerNight < 0) {
    throw new ApiError(400, "INVALID_BODY", '"pricePerNight" must be a number >= 0');
  }
  if (pricePerNight > MAX_PRICE_PER_NIGHT || Math.round(pricePerNight * 100) !== pricePerNight * 100) {
    throw new ApiError(400, "INVALID_BODY", `"pricePerNight" must be at most ${MAX_PRICE_PER_NIGHT} with at most two decimals`);
  }
  if (typeof from !== "string" || !parseDate(from)) {
    throw new ApiError(400, "INVALID_DATE", '"from" must be a valid date in YYYY-MM-DD format');
  }
  if (typeof to !== "string" || !parseDate(to)) {
    throw new ApiError(400, "INVALID_DATE", '"to" must be a valid date in YYYY-MM-DD format');
  }
  const days = daysInclusive(from, to);
  if (days < 1) throw new ApiError(400, "INVALID_DATE", '"to" must be the same day as "from" or later');
  if (days > MAX_UPDATE_DAYS) {
    throw new ApiError(400, "RANGE_TOO_LARGE", `Date range covers ${days} days; the maximum allowed is ${MAX_UPDATE_DAYS}`);
  }
  return { accommodationId, from, to, available, pricePerNight };
}
