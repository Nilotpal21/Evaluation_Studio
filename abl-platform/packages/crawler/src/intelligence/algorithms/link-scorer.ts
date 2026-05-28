/**
 * Link Scorer — evaluates discovered links to prioritize content pages
 * over utility/navigation links.
 *
 * Zero LLM calls — pure heuristic scoring using:
 * 1. URL pattern matching (from UrlClusterer groups if provided)
 * 2. Structural context (cheerio-based DOM position analysis)
 * 3. Text relevance (anchor text quality)
 * 4. Utility page penalty (login, privacy, terms, etc.)
 *
 * Score formula: 0.4 * patternMatch + 0.3 * structuralBonus + 0.3 * textRelevance
 * Utility pages are hard-zeroed regardless of other signals.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';
import type { CrawlResultLink } from './types.js';
import type { UrlGroup } from './url-clusterer.js';

const log = createLogger('link-scorer');

// Re-export UrlGroup for consumers who import from link-scorer
export type { UrlGroup } from './url-clusterer.js';

/** A single signal contributing to a link's score */
export interface LinkSignal {
  name:
    | 'pattern_match'
    | 'structural_context'
    | 'text_relevance'
    | 'nav_penalty'
    | 'utility_penalty';
  score: number;
  description: string;
}

/** A link with its computed relevance score */
export interface ScoredLink {
  href: string;
  text: string;
  score: number; // 0.0–1.0
  signals: LinkSignal[];
  relevant: boolean; // score > relevanceThreshold
}

/** Configuration for the LinkScorer */
export interface LinkScorerConfig {
  relevanceThreshold: number; // default 0.4
  urlGroups?: UrlGroup[]; // from A3 — pattern matching boost
}

// WHY these paths: Common utility/administrative pages that rarely contain
// indexable content. Hard-zeroed to avoid wasting crawl budget.
const UTILITY_PATH_PATTERNS = [
  /^\/login\b/i,
  /^\/signin\b/i,
  /^\/signup\b/i,
  /^\/register\b/i,
  /^\/privacy\b/i,
  /^\/terms\b/i,
  /^\/contact\b/i,
  /^\/cookie\b/i,
  /^\/legal\b/i,
  /^\/logout\b/i,
  /^\/forgot-password\b/i,
  /^\/reset-password\b/i,
  /^\/unsubscribe\b/i,
  /^\/404\b/i,
  /^\/500\b/i,
];

// WHY 0.4: Default threshold — links scoring above this are considered
// relevant enough to spend crawl budget on. Balances coverage vs. focus.
const DEFAULT_RELEVANCE_THRESHOLD = 0.4;

// Weight constants for the scoring formula
const WEIGHT_PATTERN = 0.4;
const WEIGHT_STRUCTURAL = 0.3;
const WEIGHT_TEXT = 0.3;

/**
 * Convert a UrlGroup pattern like "/docs/{slug}" into a regex.
 * {param} segments match any non-slash string.
 */
function patternToRegex(pattern: string): RegExp {
  // Escape regex special chars except our {param} placeholders
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) => {
    // Don't escape our {param} braces — handle them separately
    if (match === '{' || match === '}') return match;
    return `\\${match}`;
  });
  // Replace {paramName} with a segment matcher
  const regexStr = escaped.replace(/\{[^}]+\}/g, '[^/]+');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Build a lookup structure from UrlGroups for O(1)-ish pattern matching.
 * Groups with higher counts are treated as more important patterns.
 */
function buildPatternIndex(
  groups: UrlGroup[],
): Array<{ regex: RegExp; count: number; pattern: string }> {
  return groups.map((g) => ({
    regex: patternToRegex(g.pattern),
    count: g.count,
    pattern: g.pattern,
  }));
}

/**
 * Determine the structural context of a link within the HTML.
 * Uses cheerio to find which semantic container the link sits in.
 *
 * Returns a score from -1.0 to 1.0:
 * - Positive: link is in content area (article, main, section)
 * - Negative: link is in navigation area (nav, footer, aside, header)
 * - Zero: no clear structural context (bare <a> tag)
 */
function getStructuralContext(
  $: cheerio.CheerioAPI,
  href: string,
): { score: number; container: string } {
  // Find <a> elements matching this href via filter (safe for all href characters)
  const anchors = $('a').filter(function () {
    return $(this).attr('href') === href;
  });
  if (anchors.length === 0) {
    return { score: 0, container: 'unknown' };
  }
  return evaluateAnchorContext($, anchors.first());
}

function evaluateAnchorContext(
  $: cheerio.CheerioAPI,
  anchor: ReturnType<cheerio.CheerioAPI>,
): { score: number; container: string } {
  const parents = anchor.parents().toArray();

  // Check ancestors from innermost to outermost
  for (const parent of parents) {
    const tagName = ('tagName' in parent ? (parent.tagName as string) : '').toLowerCase();

    // WHY article/main get +0.8: These are semantic content containers.
    // Links inside them are almost always content links.
    if (tagName === 'article' || tagName === 'main') {
      return { score: 0.8, container: tagName };
    }
    // WHY section gets +0.4: Sections can be content or navigation.
    // Moderate bonus acknowledges ambiguity.
    if (tagName === 'section') {
      return { score: 0.4, container: tagName };
    }
    // WHY nav gets -0.8: Navigation links are rarely content pages.
    if (tagName === 'nav') {
      return { score: -0.8, container: 'nav' };
    }
    // WHY footer gets -0.6: Footer links are typically legal/utility pages.
    if (tagName === 'footer') {
      return { score: -0.6, container: 'footer' };
    }
    // WHY aside gets -0.4: Sidebar links are often secondary navigation.
    if (tagName === 'aside') {
      return { score: -0.4, container: 'aside' };
    }
    // WHY header gets -0.3: Header links are often navigation but less
    // penalized than nav because headers sometimes contain featured content.
    if (tagName === 'header') {
      return { score: -0.3, container: 'header' };
    }
  }

  // No semantic container found — neutral score
  return { score: 0, container: 'none' };
}

/**
 * Evaluate the quality of anchor text as a content relevance signal.
 * Good anchor text: descriptive, multi-word, not just "click here" or "read more".
 * Returns 0.0–1.0.
 */
function scoreTextRelevance(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  // WHY these patterns: Generic anchor text provides no content signal.
  const genericPatterns = [
    /^(click here|read more|learn more|more|here|link|see more|view|details)$/i,
    /^(back|next|previous|home|menu|close|open|toggle|expand|collapse)$/i,
    /^\d+$/, // Just a number (pagination)
    /^[→←↑↓»«►◄▶◀]$/, // Arrow/icon characters
  ];

  for (const pattern of genericPatterns) {
    if (pattern.test(trimmed)) return 0.2;
  }

  // Longer, descriptive text is a better content signal
  const wordCount = trimmed.split(/\s+/).length;

  if (wordCount >= 4) return 1.0; // "Understanding Widget Architecture" — very descriptive
  if (wordCount >= 2) return 0.7; // "Product Overview" — decent
  if (trimmed.length >= 10) return 0.5; // Single long word — moderate

  return 0.3; // Short single word — weak signal
}

/**
 * Composite scorer that evaluates discovered links to prioritize
 * content pages over utility/navigation links.
 *
 * Zero LLM calls — pure heuristic.
 */
export class LinkScorer {
  private readonly threshold: number;
  private readonly patternIndex: Array<{ regex: RegExp; count: number; pattern: string }>;
  private readonly maxGroupCount: number;

  constructor(config?: Partial<LinkScorerConfig>) {
    this.threshold = config?.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
    const groups = config?.urlGroups ?? [];
    this.patternIndex = buildPatternIndex(groups);
    // Track the max count for normalization
    this.maxGroupCount = groups.length > 0 ? Math.max(...groups.map((g) => g.count), 1) : 1;
  }

  /**
   * Score all links from a crawled page.
   * @param links - Links extracted from the page
   * @param pageUrl - The URL of the page the links were found on (used for resolving relative URLs)
   * @param html - Raw HTML of the page (used for structural context analysis)
   */
  scoreLinks(links: CrawlResultLink[], pageUrl: string, html: string): ScoredLink[] {
    if (links.length === 0) return [];

    // Parse HTML once for structural analysis
    const $ = cheerio.load(html);
    return this._scoreLinksInternal($, links, pageUrl);
  }

  /**
   * Score all links using a pre-parsed cheerio DOM.
   * Use this when the caller has already parsed HTML with cheerio
   * to avoid redundant parsing.
   */
  scoreLinksWithDom(
    $: cheerio.CheerioAPI,
    links: CrawlResultLink[],
    pageUrl: string,
  ): ScoredLink[] {
    if (links.length === 0) return [];
    return this._scoreLinksInternal($, links, pageUrl);
  }

  /**
   * Score links and return only those above the relevance threshold.
   */
  filterRelevant(links: CrawlResultLink[], pageUrl: string, html: string): ScoredLink[] {
    return this.scoreLinks(links, pageUrl, html).filter((s) => s.relevant);
  }

  /**
   * Score links and return only those above the relevance threshold,
   * using a pre-parsed cheerio DOM.
   */
  filterRelevantWithDom(
    $: cheerio.CheerioAPI,
    links: CrawlResultLink[],
    pageUrl: string,
  ): ScoredLink[] {
    return this.scoreLinksWithDom($, links, pageUrl).filter((s) => s.relevant);
  }

  /**
   * Shared implementation for scoreLinks() and scoreLinksWithDom().
   * All scoring logic lives here.
   */
  private _scoreLinksInternal(
    $: cheerio.CheerioAPI,
    links: CrawlResultLink[],
    pageUrl: string,
  ): ScoredLink[] {
    const scored = links.map((link) => this.scoreLink(link, pageUrl, $));

    log.debug('Scored links', {
      pageUrl,
      total: links.length,
      relevant: scored.filter((s) => s.relevant).length,
    });

    return scored;
  }

  /**
   * Score a single link.
   */
  private scoreLink(link: CrawlResultLink, pageUrl: string, $: cheerio.CheerioAPI): ScoredLink {
    const signals: LinkSignal[] = [];
    const resolvedHref = this.resolveHref(link.href, pageUrl);
    let pathname: string;

    try {
      pathname = new URL(resolvedHref).pathname;
    } catch {
      // Invalid URL — treat as low relevance
      return {
        href: link.href,
        text: link.text,
        score: 0,
        signals: [
          {
            name: 'utility_penalty',
            score: 0,
            description: 'Invalid URL — cannot parse',
          },
        ],
        relevant: false,
      };
    }

    // --- Utility page check (hard zero) ---
    const isUtility = UTILITY_PATH_PATTERNS.some((p) => p.test(pathname));
    if (isUtility) {
      signals.push({
        name: 'utility_penalty',
        score: 0,
        description: `Utility page detected: ${pathname}`,
      });
      return {
        href: link.href,
        text: link.text,
        score: 0,
        signals,
        relevant: false,
      };
    }

    // --- Pattern matching (from UrlGroups) ---
    const patternScore = this.scorePatternMatch(pathname);
    signals.push({
      name: 'pattern_match',
      score: patternScore,
      description:
        patternScore > 0
          ? `Matches known URL pattern (score: ${patternScore.toFixed(2)})`
          : 'No known URL pattern match',
    });

    // --- Structural context ---
    const structural = getStructuralContext($, link.href);
    // Normalize structural score from [-1, 1] to [0, 1]
    const structuralNormalized = (structural.score + 1) / 2;
    const structuralSignalName: LinkSignal['name'] =
      structural.score < 0 ? 'nav_penalty' : 'structural_context';
    signals.push({
      name: structuralSignalName,
      score: structuralNormalized,
      description:
        structural.container === 'none'
          ? 'No semantic container — neutral structural context'
          : `Link in <${structural.container}> (raw: ${structural.score.toFixed(2)})`,
    });

    // --- Text relevance ---
    const textScore = scoreTextRelevance(link.text);
    signals.push({
      name: 'text_relevance',
      score: textScore,
      description:
        textScore >= 0.7
          ? `Descriptive anchor text: "${link.text}"`
          : textScore >= 0.3
            ? `Moderate anchor text: "${link.text}"`
            : `Weak/generic anchor text: "${link.text}"`,
    });

    // --- Composite score ---
    const score = Math.max(
      0,
      Math.min(
        1,
        WEIGHT_PATTERN * patternScore +
          WEIGHT_STRUCTURAL * structuralNormalized +
          WEIGHT_TEXT * textScore,
      ),
    );

    return {
      href: link.href,
      text: link.text,
      score,
      signals,
      relevant: score > this.threshold,
    };
  }

  /**
   * Score how well a URL pathname matches known UrlGroup patterns.
   * Returns 0.0 if no groups configured, 0.0–1.0 based on match + group popularity.
   */
  private scorePatternMatch(pathname: string): number {
    if (this.patternIndex.length === 0) return 0.5; // No groups — neutral fallback

    for (const entry of this.patternIndex) {
      if (entry.regex.test(pathname)) {
        // Scale by group popularity: more pages in group = more important pattern
        // Minimum 0.6 for any match, up to 1.0 for the most popular group
        const popularityBonus = (entry.count / this.maxGroupCount) * 0.4;
        return Math.min(1.0, 0.6 + popularityBonus);
      }
    }

    // No pattern match — low score (unknown pattern)
    return 0.2;
  }

  /**
   * Resolve a potentially relative href against the page URL.
   */
  private resolveHref(href: string, pageUrl: string): string {
    try {
      return new URL(href, pageUrl).href;
    } catch {
      return href;
    }
  }
}
