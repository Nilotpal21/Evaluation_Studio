/**
 * URL Heuristics — Shared URL analysis utilities for the crawler.
 *
 * Consolidates URL heuristic functions that were previously duplicated
 * across pattern-matcher.ts, ExplorePanel.tsx, and depth-prober.ts.
 */

/**
 * Detect whether a URL path segment looks like a variable/ID rather than
 * a meaningful category name.
 *
 * Matches: UUIDs, SKU codes, hex strings, long numeric IDs, product slugs
 * with model numbers (e.g., "Epson-ET-2400", "iPhone-15-Pro").
 */
export function isLikelyVariable(segment: string): boolean {
  // Contains underscores + alphanumeric mix (SKU-like)
  if (/^[A-Z]{2,4}_[A-Z0-9]{6,}$/i.test(segment)) return true;
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  // Pure numeric and long
  if (/^\d{6,}$/.test(segment)) return true;
  // Hex string (8+ chars)
  if (/^[0-9a-f]{8,}$/i.test(segment) && !/[g-zG-Z]/.test(segment)) return true;
  // Very long segment (likely an ID or encoded value)
  if (segment.length > 30) return true;
  // Product/entity slug: contains digits mixed with hyphens (Epson-ET-2400, iPhone-15-Pro)
  if (/^[A-Za-z]+-[A-Za-z0-9-]*\d+[A-Za-z0-9-]*$/.test(segment)) return true;
  // Hyphenated slug with 3+ parts where at least one part has digits
  const parts = segment.split('-');
  if (parts.length >= 3 && parts.some((p) => /\d/.test(p))) return true;

  return false;
}

/** Tracking query parameters to strip during normalization */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'ref',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'dclid',
  '_ga',
  '_gl',
]);

/**
 * Normalize a URL for deduplication and comparison.
 *
 * - Strips fragment (#...)
 * - Removes tracking parameters (utm_*, fbclid, gclid, ref, etc.)
 * - Removes trailing slashes (except root /)
 * - Sorts remaining query parameters
 */
export function normalizeDiscoveryUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  // Strip fragment
  url.hash = '';

  // Remove tracking params, sort remaining
  const params = new URLSearchParams();
  const entries = [...url.searchParams.entries()];
  entries.sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      params.append(key, value);
    }
  }

  const search = params.toString();
  let result = `${url.origin}${url.pathname}`;

  // Remove trailing slash (except root)
  if (result.endsWith('/') && url.pathname !== '/') {
    result = result.slice(0, -1);
  }

  if (search) {
    result += `?${search}`;
  }

  return result;
}
