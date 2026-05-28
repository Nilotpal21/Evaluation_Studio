/**
 * Resolve the effective similarity threshold for a search query.
 *
 * Precedence:
 *  1. A valid explicit per-request `similarityThreshold` (0–1) — wins, letting
 *     a caller override per query (including 0 to disable filtering).
 *  2. The index's configured `searchDefaults.similarityThreshold` (set in
 *     Studio → KB Settings) — applied as the default when the request omits it.
 *  3. Otherwise undefined — the query pipeline keeps its 0.0 floor (no
 *     filtering).
 *
 * Only a positive, in-range configured value is applied; a stored 0 / missing /
 * out-of-range value leaves the threshold unset, so behaviour is unchanged for
 * any index that has not configured a relevance floor.
 */
export function resolveSimilarityThreshold(
  requestValue: unknown,
  verifiedIndex: { searchDefaults?: { similarityThreshold?: unknown } } | undefined,
): number | undefined {
  if (typeof requestValue === 'number' && requestValue >= 0 && requestValue <= 1) {
    return requestValue;
  }
  const configured = verifiedIndex?.searchDefaults?.similarityThreshold;
  if (typeof configured === 'number' && configured > 0 && configured <= 1) {
    return configured;
  }
  return undefined;
}
