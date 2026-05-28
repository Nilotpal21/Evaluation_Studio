/**
 * Pattern Matcher — URL Pattern Learning & Scoring
 *
 * Given 1-3 sample URLs, learns a URL template (fixed vs variable segments).
 * Scores any discovered URL against the learned pattern (0-100).
 *
 * Used by the recursive discovery crawler to prioritize URLs
 * that match the user's desired content pattern.
 *
 * Pure functions — no side effects, fully testable.
 */

import { createLogger } from '@abl/compiler/platform';
import { isLikelyVariable } from '@abl/crawler';

const logger = createLogger('pattern-matcher');

// ─── Types ──────────────────────────────────────────────────────────

/** A segment in the URL template — either fixed or variable */
export interface TemplateSegment {
  /** The position index in the path */
  position: number;
  /** Fixed value (null if variable) */
  value: string | null;
  /** Whether this segment varies across samples */
  isVariable: boolean;
}

/** Learned pattern from sample URLs */
export interface LearnedPattern {
  /** The domain of the samples */
  domain: string;
  /** URL template with placeholders, e.g. "/Support/Printers/{}/{}/{}/s/{}" */
  urlTemplate: string;
  /** Common path prefix, e.g. "/Support/Printers/" */
  pathPrefix: string;
  /** Structured segments for scoring */
  segments: TemplateSegment[];
  /** Total segment count in the template */
  depth: number;
  /** Number of sample URLs used to learn this pattern */
  sampleCount: number;
  /** True when ALL segments are variable — pattern matches everything, discriminates nothing */
  degenerate?: boolean;
}

/** Result of scoring a URL against a pattern */
export interface MatchScore {
  /** Overall score 0-100 */
  score: number;
  /** How many fixed segments matched */
  fixedMatches: number;
  /** How many fixed segments exist in the template */
  fixedTotal: number;
  /** Whether the prefix matches */
  prefixMatch: boolean;
  /** Whether the depth (segment count) is similar */
  depthMatch: boolean;
  /** Score tier classification */
  tier: ScoreTier;
}

/** Score tier classification for UI display and crawl decisions */
export type ScoreTier = 'hot' | 'warm' | 'cold';

/** Threshold boundaries for score tiers */
export const SCORE_TIERS = {
  /** Hot: strong match, include in results (score >= 80) */
  HOT_MIN: 80,
  /** Warm: partial match, worth crawling deeper (score >= 40) */
  WARM_MIN: 40,
  /** Cold: below 40, unlikely to be relevant */
} as const;

// ─── Pattern Learning ───────────────────────────────────────────────

/**
 * Parse a URL into its domain and path segments.
 * Handles URLs with or without protocol prefix.
 */
export function parseUrl(raw: string): { domain: string; segments: string[] } | null {
  try {
    const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    const segments = url.pathname.split('/').filter(Boolean);
    return { domain: url.hostname, segments };
  } catch {
    return null;
  }
}

/**
 * Learn a URL pattern from 1-3 sample URLs.
 *
 * Compares path segments across samples:
 * - Segments that are identical across all samples → fixed
 * - Segments that differ → variable (placeholder)
 *
 * With 1 sample: all segments treated as potentially fixed,
 * but segments that look like IDs/slugs are marked variable.
 */
export function learnPattern(sampleUrls: string[]): LearnedPattern | null {
  if (sampleUrls.length === 0) return null;

  const parsed = sampleUrls.map(parseUrl).filter(Boolean) as Array<{
    domain: string;
    segments: string[];
  }>;
  if (parsed.length === 0) return null;

  const domain = parsed[0].domain;
  const segmentArrays = parsed.map((p) => p.segments);
  const maxLen = Math.max(...segmentArrays.map((s) => s.length));
  const minLen = Math.min(...segmentArrays.map((s) => s.length));

  const segments: TemplateSegment[] = [];
  let prefixEnd = 0;
  let prefixContinuous = true;

  for (let i = 0; i < maxLen; i++) {
    // Collect values at this position across all samples
    const values = segmentArrays.filter((s) => i < s.length).map((s) => s[i]);

    if (values.length === 0) break;

    const uniqueValues = new Set(values);

    if (uniqueValues.size === 1 && values.length === parsed.length) {
      // All samples have the same value at this position
      const value = values[0];

      // With single sample: heuristically detect variable segments
      // (SKU-like strings, UUIDs, long numeric IDs)
      const looksVariable = parsed.length === 1 && isLikelyVariable(value);

      segments.push({
        position: i,
        value: looksVariable ? null : value,
        isVariable: looksVariable,
      });

      if (!looksVariable && prefixContinuous) {
        prefixEnd = i + 1;
      } else {
        prefixContinuous = false;
      }
    } else {
      // Values differ — this is a variable segment
      segments.push({
        position: i,
        value: null,
        isVariable: true,
      });
      prefixContinuous = false;
    }
  }

  // Build the template string
  const templateParts = segments.map((s) => (s.isVariable ? '{}' : s.value));
  const urlTemplate = '/' + templateParts.join('/');

  // Build the prefix
  // With a single sample, cap prefix depth to avoid overly specific scopes.
  // e.g. /Support/Printers/All-In-Ones/ is useful; adding ET-Series/Epson-ET-2400/s/ is too narrow.
  const maxPrefixDepth = parsed.length === 1 ? Math.min(prefixEnd, 3) : prefixEnd;
  const prefixParts = segments.slice(0, maxPrefixDepth).map((s) => s.value);
  const pathPrefix = prefixParts.length > 0 ? '/' + prefixParts.join('/') + '/' : '/';

  // Detect degenerate patterns: all segments variable means the pattern
  // matches everything and discriminates nothing. This happens when samples
  // come from completely different site sections (e.g. /faq/* + /Support/*).
  const fixedCount = segments.filter((s) => !s.isVariable).length;
  const degenerate = segments.length > 0 && fixedCount === 0;

  if (degenerate) {
    logger.warn('Degenerate pattern detected — all segments are variable', {
      sampleCount: parsed.length,
      urlTemplate,
      depth: segments.length,
    });
  } else {
    logger.info('Pattern learned', {
      sampleCount: parsed.length,
      urlTemplate,
      pathPrefix,
      depth: segments.length,
    });
  }

  return {
    domain,
    urlTemplate,
    pathPrefix,
    segments,
    depth: segments.length,
    sampleCount: parsed.length,
    degenerate,
  };
}

// isLikelyVariable — re-exported from @abl/crawler (imported at top of file)
export { isLikelyVariable };

// ─── Score Classification ────────────────────────────────────────────

/**
 * Classify a numeric score (0-100) into a tier.
 *
 * - hot  (≥80): strong pattern match — include in results
 * - warm (40-79): partial match — worth exploring deeper
 * - cold (<40): unlikely relevant — skip unless bridge page
 */
export function classifyScore(score: number): ScoreTier {
  if (score >= SCORE_TIERS.HOT_MIN) return 'hot';
  if (score >= SCORE_TIERS.WARM_MIN) return 'warm';
  return 'cold';
}

// ─── URL Scoring ────────────────────────────────────────────────────

/**
 * Score a URL against a learned pattern.
 *
 * Scoring components (weighted):
 * - Prefix match (40%): Does the URL start with the pattern's pathPrefix?
 * - Fixed segment match (40%): How many fixed segments in the template match?
 * - Depth similarity (20%): Is the URL depth similar to the template depth?
 *
 * Returns 0-100 score.
 */
export function scoreUrl(url: string, pattern: LearnedPattern): MatchScore {
  const parsed = parseUrl(url);
  if (!parsed) {
    return {
      score: 0,
      fixedMatches: 0,
      fixedTotal: 0,
      prefixMatch: false,
      depthMatch: false,
      tier: 'cold',
    };
  }

  // Domain must match
  if (parsed.domain !== pattern.domain) {
    return {
      score: 0,
      fixedMatches: 0,
      fixedTotal: 0,
      prefixMatch: false,
      depthMatch: false,
      tier: 'cold',
    };
  }

  // Degenerate patterns (all segments variable) give a flat warm score
  // to same-domain URLs instead of scoring everything as hot (100).
  if (pattern.degenerate) {
    return {
      score: 50,
      fixedMatches: 0,
      fixedTotal: 0,
      prefixMatch: true,
      depthMatch: true,
      tier: 'warm',
    };
  }

  const urlSegments = parsed.segments;
  const fixedSegments = pattern.segments.filter((s) => !s.isVariable);
  const fixedTotal = fixedSegments.length;

  // Prefix match
  const prefixSegments = pattern.pathPrefix.split('/').filter(Boolean);
  const prefixMatch =
    prefixSegments.length === 0 ||
    prefixSegments.every((seg, i) => i < urlSegments.length && urlSegments[i] === seg);

  // Fixed segment match
  let fixedMatches = 0;
  for (const seg of fixedSegments) {
    if (
      seg.value !== null &&
      seg.position < urlSegments.length &&
      urlSegments[seg.position] === seg.value
    ) {
      fixedMatches++;
    }
  }

  // Depth similarity
  const depthDiff = Math.abs(urlSegments.length - pattern.depth);
  const depthMatch = depthDiff <= 1;

  // Weighted score
  const prefixScore = prefixMatch ? 40 : 0;
  const fixedScore = fixedTotal > 0 ? (fixedMatches / fixedTotal) * 40 : 40;
  const depthScore = depthMatch ? 20 : Math.max(0, 20 - depthDiff * 5);

  const score = Math.round(prefixScore + fixedScore + depthScore);

  return { score, fixedMatches, fixedTotal, prefixMatch, depthMatch, tier: classifyScore(score) };
}

/**
 * Check if a URL is "in scope" for the crawl.
 *
 * A URL is in scope if:
 * 1. Same domain as the pattern
 * 2. Starts with the pattern's path prefix (or prefix is root)
 */
export function isInScope(url: string, pattern: LearnedPattern): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (parsed.domain !== pattern.domain) return false;

  // Root prefix means everything is in scope
  if (pattern.pathPrefix === '/') return true;

  const urlPath = '/' + parsed.segments.join('/') + '/';
  return urlPath.startsWith(pattern.pathPrefix);
}

// ─── Multi-Pattern Learning ──────────────────────────────────────────

/**
 * Learn multiple URL patterns by grouping sample URLs by their first 1-2
 * path segments. Useful when samples come from different site sections
 * (e.g. /faq/* and /Support/*) which would produce a degenerate single pattern.
 *
 * Returns only non-degenerate patterns. May return an empty array if all
 * sub-groups produce degenerate patterns.
 */
export function learnPatterns(urls: string[]): LearnedPattern[] {
  if (urls.length === 0) return [];

  // Group URLs by their first 1-2 path segments as a prefix key
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const parsed = parseUrl(url);
    if (!parsed) continue;

    // Use first 1-2 segments as grouping key (e.g. "faq" or "Support/Printers")
    const keySegments = parsed.segments.slice(0, Math.min(2, parsed.segments.length));
    const key = keySegments.join('/') || '/';

    const group = groups.get(key);
    if (group) {
      group.push(url);
    } else {
      groups.set(key, [url]);
    }
  }

  // If all URLs share the same prefix group, just learn a single pattern
  if (groups.size <= 1) {
    const pattern = learnPattern(urls);
    if (!pattern) return [];
    return pattern.degenerate ? [] : [pattern];
  }

  // Learn a pattern per group, filter out degenerate ones
  const patterns: LearnedPattern[] = [];
  for (const [, groupUrls] of groups) {
    const pattern = learnPattern(groupUrls);
    if (pattern && !pattern.degenerate) {
      patterns.push(pattern);
    }
  }

  logger.info('Multi-pattern learning complete', {
    inputUrls: urls.length,
    groups: groups.size,
    nonDegeneratePatterns: patterns.length,
  });

  return patterns;
}

/**
 * Score a URL against multiple patterns, returning the highest score.
 * Useful when samples produced multiple non-degenerate patterns.
 *
 * If patterns array is empty, returns a warm score (50) as fallback.
 */
export function scoreUrlMulti(
  url: string,
  patterns: LearnedPattern[],
): { score: number; tier: ScoreTier } {
  if (patterns.length === 0) {
    return { score: 50, tier: 'warm' };
  }

  let bestScore = 0;
  for (const pattern of patterns) {
    const result = scoreUrl(url, pattern);
    if (result.score > bestScore) {
      bestScore = result.score;
    }
  }

  return { score: bestScore, tier: classifyScore(bestScore) };
}

/**
 * Normalize a URL for deduplication.
 *
 * Strips: trailing slash, fragment (#), common tracking params.
 * Lowercases the domain.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
    const url = new URL(withProtocol);

    // Remove fragment
    url.hash = '';

    // Remove common tracking params
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'ref',
      'fbclid',
      'gclid',
    ];
    for (const param of trackingParams) {
      url.searchParams.delete(param);
    }

    // Normalize
    let normalized = url.origin.toLowerCase() + url.pathname;

    // Remove trailing slash (except for root)
    if (normalized.length > url.origin.length + 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Re-add search params if any remain
    const search = url.searchParams.toString();
    if (search) {
      normalized += '?' + search;
    }

    return normalized;
  } catch {
    return null;
  }
}
