/**
 * Metric Value Formatters
 *
 * Two-state metric display: a numeric value (including zero) or an
 * em-dash for "no data yet". There is no separate "N/A" state — if a
 * metric has been computed it has a value, even if that value is zero.
 *
 * Use the `null` / `undefined` sentinel to mean "no data computed".
 * Pass an actual `0` to render "0" — the formatters treat zero as a
 * real value, not a missing one.
 *
 * Audit reference: Theme 12 (Studio UI/UX audit, 2026-04-25).
 */

const NO_DATA = '—';

type MaybeNumber = number | null | undefined;

function isMissing(value: MaybeNumber): boolean {
  return value == null || Number.isNaN(value);
}

/**
 * Format a numeric metric to a fixed-decimal string, or em-dash when missing.
 * `0` always renders as "0.0" (or the supplied decimal precision).
 */
export function metricNumber(value: MaybeNumber, decimals = 1): string {
  return isMissing(value) ? NO_DATA : (value as number).toFixed(decimals);
}

/**
 * Format an integer metric with thousands separators, or em-dash when missing.
 */
export function metricInteger(value: MaybeNumber): string {
  return isMissing(value) ? NO_DATA : (value as number).toLocaleString();
}

/**
 * Format a percentage metric (assumes the input is the percentage value
 * itself, e.g. `72.1` for "72.1%"), or em-dash when missing.
 */
export function metricPercent(value: MaybeNumber, decimals = 1): string {
  return isMissing(value) ? NO_DATA : `${(value as number).toFixed(decimals)}%`;
}

/**
 * Format a currency metric, or em-dash when missing.
 */
export function metricCurrency(value: MaybeNumber, decimals = 0): string {
  if (isMissing(value)) return NO_DATA;
  return `$${(value as number).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Returns true when the value represents "no data" — useful for
 * consumers that need to suppress unit suffixes alongside the em-dash.
 */
export function isMetricMissing(value: MaybeNumber): boolean {
  return isMissing(value);
}

export const METRIC_NO_DATA = NO_DATA;
