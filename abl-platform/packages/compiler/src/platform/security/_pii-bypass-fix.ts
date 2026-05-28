/**
 * Per-pod kill switch for the registry-bypass fix at trace-scrubber,
 * cel-functions, and action-executors. Default is fix-enabled (operator
 * must explicitly opt out by setting PII_BYPASS_FIX_ENABLED=false).
 *
 * Naming follows the runtime's existing _ENABLED convention. Removed
 * after one stable release cycle (HLD §11; tracked in P5.6).
 */

export function isPIIBypassFixEnabled(): boolean {
  return process.env.PII_BYPASS_FIX_ENABLED !== 'false';
}
