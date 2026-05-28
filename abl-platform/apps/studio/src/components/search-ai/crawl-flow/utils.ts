/**
 * Crawl Flow — Shared utilities
 *
 * Section naming, time estimation, and other helpers used across
 * CrawlFlowV5, State2Analysis, and ExplorePanel.
 */

/**
 * Derive a readable section name from a URL pattern.
 *
 * Uses multiple literal path segments (not just the last one) to produce
 * meaningful names. For example:
 *   /Support/Printers/{brand}/{model}/s/{id}  →  "Support > Printers"
 *   /docs/{slug}                               →  "Docs"
 *   /p/{sku}                                   →  "Products"   (single-char fallback)
 *   /blog/2024/{slug}                          →  "Blog > 2024"
 */
export function deriveNameFromPattern(pattern: string): string {
  // Strip wildcards and trailing slashes to get literal segments
  const cleaned = pattern
    .replace(/\{[^}]+\}/g, '')
    .replace(/\*/g, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);

  if (parts.length === 0) return 'Root';

  // Title-case a single segment: "my-page" → "My Page"
  const titleCase = (s: string): string =>
    s
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

  // Use up to 3 literal segments joined with " > "
  const segments = parts.slice(0, 3).map(titleCase).filter(Boolean);

  if (segments.length === 0) return 'Root';

  // If the primary name is a single character (e.g. "P", "S"), it's useless.
  // Fall back to a longer description or use "Pages" suffix.
  const name = segments.join(' > ');
  if (name.length <= 1) {
    return `/${parts[0]}/ Pages`;
  }

  return name;
}

/**
 * Derive a better section name from page titles when the path-based name is cryptic.
 *
 * Finds the most common meaningful word or phrase in titles (excluding the site name).
 * For example, pages titled "Product X | Products | Epson US" → "Products"
 */
export function deriveNameFromTitles(
  pages: Array<{ url: string; title: string }>,
  fallback: string,
): string {
  const titles = pages.map((p) => p.title).filter(Boolean);
  if (titles.length === 0) return fallback;

  // Split titles by common separators (|, -, –, —) and count segments
  const segmentCounts = new Map<string, number>();
  for (const title of titles) {
    const parts = title
      .split(/\s*[|–—-]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      // Skip very short or very long segments, and skip the site name (last segment)
      if (part.length < 3 || part.length > 40) continue;
      segmentCounts.set(part, (segmentCounts.get(part) ?? 0) + 1);
    }
  }

  if (segmentCounts.size === 0) return fallback;

  // Find the most common segment that appears in > 50% of titles
  // but isn't the most common (which is usually the site name like "Epson US")
  const sorted = Array.from(segmentCounts.entries()).sort((a, b) => b[1] - a[1]);
  const threshold = Math.max(2, titles.length * 0.3);

  // The top entry is often the site name — skip it if there's a good second option
  for (const [segment, count] of sorted) {
    if (count < threshold) break;
    // Skip likely site names (appears in almost all titles)
    if (count >= titles.length * 0.9 && sorted.length > 1) continue;
    return segment;
  }

  // If all segments are the site name, use the second-most-common
  if (sorted.length > 1 && sorted[1][1] >= threshold) {
    return sorted[1][0];
  }

  return fallback;
}

/** Rough time estimate based on page count */
export function estimateTime(count: number): string {
  const seconds = count * 2;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}
