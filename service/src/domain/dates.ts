/** Calendar days as "YYYY-MM-DD" strings; all arithmetic is in UTC so no time zone can shift a day. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns the UTC Date for a valid calendar day, or null for a malformed or non-existent one. */
export function parseDate(value: string): Date | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Number of days in the inclusive range; both must be valid. */
export function daysInclusive(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) throw new Error(`invalid date range ${from}..${to}`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

export interface DateRange {
  from: string;
  to: string;
}

/** SYNC-01: contiguous chunks of at most `maxDays` (inclusive) covering exactly from..to. */
export function splitRange(from: string, to: string, maxDays = 31): DateRange[] {
  const total = daysInclusive(from, to);
  if (total < 1) throw new Error(`invalid date range ${from}..${to}`);
  const start = parseDate(from)!;
  const chunks: DateRange[] = [];
  for (let offset = 0; offset < total; offset += maxDays) {
    const length = Math.min(maxDays, total - offset);
    chunks.push({ from: formatDate(addDays(start, offset)), to: formatDate(addDays(start, offset + length - 1)) });
  }
  return chunks;
}
