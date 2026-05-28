/**
 * DiscoveredUrlSet — O(1) dedup URL accumulator with bounded size.
 *
 * Map-based implementation replaces array + structuredClone pattern.
 * Normalizes URLs before comparison. Caps at MAX_DISCOVERED_URLS
 * with eviction of lowest-confidence entries.
 */

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
 * Mirrors packages/crawler/src/intelligence/utils/url-heuristics.ts
 */
export function normalizeDiscoveryUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  url.hash = '';

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

  if (result.endsWith('/') && url.pathname !== '/') {
    result = result.slice(0, -1);
  }

  if (search) {
    result += `?${search}`;
  }

  return result;
}

/** Maximum URLs to track before eviction */
export const MAX_DISCOVERED_URLS = 10_000;

/** Confidence priority for eviction (lower = evicted first) */
const CONFIDENCE_PRIORITY: Record<string, number> = {
  inferred: 0,
  projected: 1,
  verified: 2,
};

interface UrlEntry {
  href: string;
  text: string;
  confidence: 'verified' | 'projected' | 'inferred';
  depth: number;
  group?: string;
}

/**
 * O(1) URL deduplication set with bounded size.
 * Uses normalized URLs as keys for consistent dedup.
 * Maintains per-confidence-tier buckets for O(1) eviction.
 */
export class DiscoveredUrlSet {
  private readonly entries = new Map<string, UrlEntry>();
  /** Buckets keyed by confidence tier for O(1) eviction */
  private readonly buckets: Map<string, Set<string>> = new Map([
    ['inferred', new Set()],
    ['projected', new Set()],
    ['verified', new Set()],
  ]);

  /** Add or upgrade a URL entry. Returns true if new entry added. */
  add(entry: UrlEntry): boolean {
    const key = normalizeDiscoveryUrl(entry.href);
    const existing = this.entries.get(key);

    if (existing) {
      // Upgrade confidence if the new entry is higher
      const existingPriority = CONFIDENCE_PRIORITY[existing.confidence] ?? 0;
      const newPriority = CONFIDENCE_PRIORITY[entry.confidence] ?? 0;
      if (newPriority > existingPriority) {
        // Move from old bucket to new bucket
        this.buckets.get(existing.confidence)?.delete(key);
        this.buckets.get(entry.confidence)?.add(key);
        this.entries.set(key, entry);
      }
      return false;
    }

    // Evict lowest-confidence entry if at capacity
    if (this.entries.size >= MAX_DISCOVERED_URLS) {
      this.evictLowest();
    }

    this.entries.set(key, entry);
    this.buckets.get(entry.confidence)?.add(key);
    return true;
  }

  /** Check if a URL (normalized) exists in the set */
  has(href: string): boolean {
    return this.entries.has(normalizeDiscoveryUrl(href));
  }

  /** Get entry by URL */
  get(href: string): UrlEntry | undefined {
    return this.entries.get(normalizeDiscoveryUrl(href));
  }

  /** Current size */
  get size(): number {
    return this.entries.size;
  }

  /** Get all entries as array */
  toArray(): UrlEntry[] {
    return [...this.entries.values()];
  }

  /** Serialize for persistence */
  serialize(): Array<{ href: string; text: string; confidence: string; depth: number }> {
    return this.toArray().map((e) => ({
      href: e.href,
      text: e.text,
      confidence: e.confidence,
      depth: e.depth,
    }));
  }

  /** Restore from serialized data */
  static deserialize(
    data: Array<{ href: string; text: string; confidence: string; depth: number }>,
  ): DiscoveredUrlSet {
    const set = new DiscoveredUrlSet();
    for (const entry of data) {
      set.add({
        href: entry.href,
        text: entry.text,
        confidence: entry.confidence as 'verified' | 'projected' | 'inferred',
        depth: entry.depth,
      });
    }
    return set;
  }

  /** Remove the lowest-confidence entry to make room — O(1) via buckets */
  private evictLowest(): void {
    // Evict from lowest-confidence bucket first
    const tiers: Array<'inferred' | 'projected' | 'verified'> = [
      'inferred',
      'projected',
      'verified',
    ];
    for (const tier of tiers) {
      const bucket = this.buckets.get(tier);
      if (bucket && bucket.size > 0) {
        const firstKey = bucket.values().next().value as string;
        bucket.delete(firstKey);
        this.entries.delete(firstKey);
        return;
      }
    }
  }
}

/**
 * Normalize a pattern string for comparison: lowercase, strip leading/trailing slashes.
 * Used for section deduplication and subset detection.
 */
export function normalizePattern(pattern: string): string {
  return pattern.toLowerCase().replace(/^\/+|\/+$/g, '');
}

/**
 * Check if `child` pattern is a subset of `parent` pattern.
 * e.g. "/support/printers" is a subset of "/support" (child starts with parent + '/').
 */
export function isSubsetOf(child: string, parent: string): boolean {
  const normChild = normalizePattern(child);
  const normParent = normalizePattern(parent);
  if (normChild === normParent) return false;
  return normChild.startsWith(normParent + '/');
}

/**
 * Extract the last non-empty path segment from a URL.
 * Used for display names in the tree.
 */
export function extractLastSegment(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return url;
  }
}
