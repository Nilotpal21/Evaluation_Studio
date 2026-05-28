/**
 * URL Normalizer — Canonical URL normalization for discovery deduplication
 *
 * Strips tracking parameters, normalizes hostname casing, sorts query params,
 * removes fragments and trailing slashes to produce canonical URLs.
 */

// ─── Constants ──────────────────────────────────────────────────────

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ref',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'twclid',
  'mc_cid',
  'mc_eid',
] as const;

// ─── Functions ──────────────────────────────────────────────────────

/**
 * Normalize a URL to its canonical form.
 *
 * - Strips fragment (#hash)
 * - Lowercases hostname
 * - Removes tracking query parameters (utm_*, fbclid, gclid, etc.)
 * - Sorts remaining query parameters alphabetically
 * - Removes trailing slash from pathname (except root "/")
 * - Prepends https:// if no protocol
 *
 * Returns the original string if it cannot be parsed as a URL.
 */
export function normalizeUrl(raw: string): string {
  try {
    const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.hostname = url.hostname.replace(/^www\./, '');
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // Strip trailing slash from the final string. The URL API always
    // appends '/' for root paths (e.g. 'https://example.com' becomes
    // 'https://example.com/'). We normalize to no-slash for consistency
    // so that normalizeUrl is idempotent on root-only URLs.
    let result = url.toString();
    if (result.endsWith('/') && url.pathname === '/') {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return raw;
  }
}

/**
 * Check if two URLs share the same domain (case-insensitive hostname comparison).
 */
export function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return (
      a.hostname.toLowerCase().replace(/^www\./, '') ===
      b.hostname.toLowerCase().replace(/^www\./, '')
    );
  } catch {
    return false;
  }
}

/**
 * Extract the bare domain from a URL, stripping "www." prefix.
 * Prepends https:// if no protocol present.
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Convert a URL to a human-readable label derived from the last path segment.
 * Decodes URI components for readability.
 */
export function urlToLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || path);
  } catch {
    return url;
  }
}

// ─── UUID / hex-ID detection patterns ──────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_PATTERN = /^[0-9a-f]{9,}$/i;
const NUMERIC_ONLY_PATTERN = /^\d+$/;

/**
 * Convert a URL slug into a human-readable title.
 *
 * - Splits on [-_~.]
 * - Title-cases each word
 * - Strips numeric-only segments and common ID patterns (long hex, UUIDs)
 * - Collapses whitespace
 *
 * Examples:
 *   "all-in-ones"                              → "All In Ones"
 *   "SPT_C11CJ67201~faq-00004ba-shared"        → "FAQ"
 *   "et-2400"                                   → "ET 2400"
 */
export function humanizeSlug(slug: string): string {
  // Split on common slug delimiters
  const parts = slug.split(/[-_~.]+/);

  // Filter out noise: numeric-only, UUIDs, long hex strings
  const meaningful = parts.filter((p) => {
    if (p.length === 0) return false;
    if (NUMERIC_ONLY_PATTERN.test(p)) return false;
    if (UUID_PATTERN.test(p)) return false;
    if (LONG_HEX_PATTERN.test(p)) return false;
    return true;
  });

  if (meaningful.length === 0) {
    // If everything was filtered, return the original slug title-cased
    return titleCase(slug);
  }

  // Title-case each meaningful word
  const titled = meaningful.map((word) => titleCase(word));

  // Collapse whitespace
  return titled.join(' ').replace(/\s+/g, ' ').trim();
}

function titleCase(word: string): string {
  if (word.length === 0) return word;
  // If the word is all-uppercase and short (like "FAQ", "ET"), keep it
  if (word.length <= 4 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
    return word;
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
