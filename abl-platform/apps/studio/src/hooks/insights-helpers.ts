/**
 * Shared helper functions for the insights dashboard hooks.
 *
 * Extracted from useAgentPerformance / useCustomerInsights / useAtAGlance /
 * useQualityMonitor to eliminate duplication. All hooks import these utilities
 * from this single module.
 */

// ── Loading state ────────────────────────────────────────────────────────────

/**
 * Returns true while any of the supplied SWR calls are still in-flight.
 * Pass only the calls whose data must be present before the page renders.
 * Secondary calls (sparklines, trend charts, paginated tables) should be
 * excluded so they can load progressively without blocking the primary view.
 */
export function combineLoading(...calls: Array<{ data: unknown; error: unknown }>): boolean {
  return calls.some(({ data, error }) => !data && !error);
}

// ── URL builder ─────────────────────────────────────────────────────────────

/**
 * Build a pipeline-analytics SWR key / URL.
 *
 * @param projectId  - Current project ID
 * @param pipelineType - Pipeline type (e.g. 'quality_evaluation')
 * @param endpoint   - Endpoint name (e.g. 'summary', 'breakdown', 'timeseries')
 * @param extra      - Additional query params (e.g. { period: '30d' })
 */
export function pipelineUrl(
  projectId: string,
  pipelineType: string,
  endpoint: string,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams({ projectId, pipelineType, endpoint, ...extra });
  return `/api/runtime/pipeline-analytics?${params.toString()}`;
}

// ── Response extraction helpers ─────────────────────────────────────────────
//
// SWR destructuring: const { data } = useSWR(...)
//   → `data` = fetcher return value = response body
//
// Response body may be:
//   A) { success, data: <payload> }                    — API wrapper
//   B) { success, data: { meta, data: [...], ... } }   — raw ClickHouse leaked through
//   C) { data: { success, data: <payload> } }          — double-wrapped (SWR + API)
//
// These helpers extract the actual payload regardless of shape.
// Uses the triple-unwrap approach (from useAgentPerformance) to handle the
// deepest nesting levels correctly.

/**
 * Extract a single object from an SWR response, handling up to three levels
 * of wrapping (SWR → API envelope → ClickHouse envelope).
 */
export function extractObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;

  // Level 1: unwrap SWR's { data: ... } or pass through
  const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  const innerObj = inner as Record<string, unknown>;

  // Level 2: unwrap API envelope { success, data: ... }
  const payload =
    'success' in innerObj && innerObj.data && typeof innerObj.data === 'object'
      ? innerObj.data
      : innerObj;
  const payloadObj = payload as Record<string, unknown>;

  // Level 3: unwrap ClickHouse envelope { meta, data: [{...}] }
  if ('meta' in payloadObj && Array.isArray(payloadObj.data)) {
    const rows = payloadObj.data as Record<string, unknown>[];
    return rows[0] ?? {};
  }

  // Guard: bare envelope with no real payload (e.g. { success: true } or
  // { success: true, data: null }) — return empty instead of leaking wrapper keys.
  if ('success' in payloadObj && !payloadObj.data) {
    return {};
  }

  return payloadObj;
}

/**
 * Extract an array from an SWR response, handling up to three levels
 * of wrapping (SWR → API envelope → ClickHouse envelope).
 */
export function extractArray(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  // Level 1: unwrap SWR's { data: ... } or pass through
  const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  const innerObj = inner as Record<string, unknown>;

  // Level 2: unwrap API envelope { success, data: ... }
  const payload = 'success' in innerObj ? innerObj.data : innerObj;

  if (Array.isArray(payload)) return payload as Record<string, unknown>[];

  // Level 3: unwrap ClickHouse envelope { data: [...] }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.data)) return p.data as Record<string, unknown>[];
  }

  return [];
}
