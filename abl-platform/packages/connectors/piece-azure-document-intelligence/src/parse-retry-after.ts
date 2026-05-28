/**
 * Parse the HTTP `Retry-After` header per RFC 7231 §7.1.3 and convert it
 * into a bounded sleep duration in milliseconds.
 *
 * - Delta-seconds integer ("120") → returns the integer * 1000.
 * - HTTP-date ("Fri, 31 Dec 2027 23:59:59 GMT") → returns max(0, date - now).
 * - Missing / malformed → returns `defaultMs`.
 *
 * The returned value is always clamped at `MAX_RETRY_AFTER_MS` (30 s) so the
 * polling loop's wall clock is bounded regardless of what Azure returns.
 */

const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 2_000;

export interface RetryAfterCarrier {
  get(name: string): string | null;
}

export function parseRetryAfter(
  headers: RetryAfterCarrier,
  defaultMs: number = DEFAULT_RETRY_AFTER_MS,
): number {
  const value = headers.get('Retry-After') ?? headers.get('retry-after');
  if (value === null || value === undefined) {
    return clamp(defaultMs);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return clamp(defaultMs);
  }

  // Delta-seconds form (integer).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return clamp(defaultMs);
    }
    return clamp(seconds * 1000);
  }

  // HTTP-date form. Date.parse returns NaN for malformed strings.
  const epoch = Date.parse(trimmed);
  if (Number.isNaN(epoch)) {
    return clamp(defaultMs);
  }
  const ms = epoch - Date.now();
  if (ms <= 0) {
    return 0;
  }
  return clamp(ms);
}

function clamp(ms: number): number {
  if (ms < 0) return 0;
  if (ms > MAX_RETRY_AFTER_MS) return MAX_RETRY_AFTER_MS;
  return ms;
}

export const _internal = {
  MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_AFTER_MS,
};
