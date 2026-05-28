/**
 * Failure Scorer — evaluates Go CrawlResult signals to predict
 * whether a page needs browser/LLM escalation.
 *
 * Zero LLM calls — pure heuristic scoring.
 *
 * Signal design rationale:
 * - Positive signals detect SPA/JS-rendered pages that return empty shells
 * - Anti-signals detect SSR frameworks that look like SPAs but have real content
 * - Score formula: max(0, min(100, sum of weighted signals))
 */

import { createLogger } from '../../logger.js';
import type { CrawlResult } from './types.js';

const log = createLogger('failure-scorer');

/** A single signal detected in the CrawlResult */
export interface FailureSignal {
  name: string;
  weight: number;
  detected: boolean;
  value: string | number; // the raw measurement
  threshold: string | number; // what triggered it
  description: string; // WHY this signal matters
}

/** Scorer output */
export interface FailureScoreResult {
  score: number; // 0-100, higher = more likely needs escalation
  shouldEscalate: boolean; // score >= threshold
  signals: FailureSignal[];
  positiveSignals: FailureSignal[]; // anti-signals (SSR evidence)
  reason: string; // human-readable summary
}

/** Signal names — typed union prevents typos in config overrides */
export type FailureSignalName =
  | 'short_text'
  | 'no_links'
  | 'empty_mount_point'
  | 'high_markup_ratio'
  | 'noscript_content'
  | 'framework_marker'
  | 'ssr_next_data'
  | 'ssr_content_rich'
  | 'structured_data'
  | 'meta_generator';

/** Configuration for the scorer */
export interface FailureScorerConfig {
  escalationThreshold: number; // default 50
  weights: Partial<Record<FailureSignalName, number>>; // override signal weights
}

/** Default weights for positive signals (indicate need for escalation) */
const DEFAULT_POSITIVE_WEIGHTS: Record<string, number> = {
  // WHY 25: SPAs render empty shells with near-zero text. 200 chars is roughly
  // 2 short sentences — anything less is likely a shell or error page.
  short_text: 25,
  // WHY 15: Hydrated pages have navigation links; empty shells typically have none.
  // Lower weight because some legitimate pages (e.g., landing pages) may have few links.
  no_links: 15,
  // WHY 30: Highest weight — an empty mount point is the strongest SPA indicator.
  // React/Vue/Next.js apps mount into div#root/app/__next. If innerHTML < 50 chars,
  // the framework hasn't hydrated yet.
  empty_mount_point: 30,
  // WHY 15: When HTML is 50x+ larger than visible text, the page is mostly
  // scripts/styles/framework boilerplate with little actual content.
  high_markup_ratio: 15,
  // WHY 10: A <noscript> tag with meaningful text explicitly tells users JS is required.
  // Lower weight because some SSR pages include noscript tags as progressive enhancement.
  noscript_content: 10,
  // WHY 10: Presence of __NEXT_DATA__, __NUXT__, or __GATSBY indicates a JS framework.
  // Low weight alone because SSR frameworks also emit these markers.
  framework_marker: 10,
};

/** Default weights for anti-signals (indicate SSR / no escalation needed) */
const DEFAULT_ANTI_WEIGHTS: Record<string, number> = {
  // WHY -20: __NEXT_DATA__ + substantial text means Next.js SSR delivered real content.
  // Strong negative weight to counteract framework_marker + short_text false positives.
  ssr_next_data: -20,
  // WHY -15: Pages with >1000 chars of text AND >5 links clearly have real content,
  // regardless of framework markers.
  ssr_content_rich: -15,
  // WHY -10: JSON-LD structured data indicates SEO-aware rendering, typically SSR.
  structured_data: -10,
  // WHY -10: <meta name="generator"> indicates a build tool rendered the page server-side.
  meta_generator: -10,
};

// WHY 50: Balanced threshold — signals are weighted so that a single strong indicator
// (empty_mount_point at 30) isn't enough alone, but two moderate signals (short_text 25 +
// no_links 15 = 40, still below 50) require additional evidence. This prevents over-escalation
// while catching genuine SPA pages.
const DEFAULT_ESCALATION_THRESHOLD = 50;

// WHY 200: Roughly 2 short sentences. Static pages with real content almost always
// exceed this. SPA shells typically have 0-50 chars of visible text.
const SHORT_TEXT_THRESHOLD = 200;

// WHY 50: Mount point innerHTML under 50 chars is essentially empty.
// React's default root div has 0 chars; some frameworks inject a spinner (~30 chars).
const EMPTY_MOUNT_INNER_THRESHOLD = 50;

// WHY 50: When HTML is 50x the text size, the page is overwhelmingly markup.
// Normal content pages have ratios of 3-15x.
const HIGH_MARKUP_RATIO_THRESHOLD = 50;

// WHY 50: A noscript message under 50 chars is likely just "Enable JS" boilerplate.
// Meaningful noscript content (describing what the page does) exceeds this.
const NOSCRIPT_TEXT_THRESHOLD = 50;

// WHY 500: Next.js SSR pages with real content have at least 500 chars of text.
// Pages with less are likely partially rendered or have hydration issues.
const SSR_TEXT_THRESHOLD = 500;

// WHY 1000: A content-rich page has at least 1000 chars — roughly a short article paragraph.
const CONTENT_RICH_TEXT_THRESHOLD = 1000;

// WHY 5: A page with navigation + content links typically has more than 5.
// This distinguishes real pages from shells with a single fallback link.
const CONTENT_RICH_LINKS_THRESHOLD = 5;

/**
 * Regex to detect empty SPA mount points.
 * Matches <div id="root">, <div id="app">, <div id="__next"> with
 * innerHTML shorter than EMPTY_MOUNT_INNER_THRESHOLD.
 *
 * WHY regex instead of DOM parsing: Avoids cheerio dependency for this single check.
 * The pattern is simple enough that regex is reliable here.
 *
 * Known limitation: Uses non-greedy [\s\S]*? which matches to the FIRST </div>.
 * For deeply nested mount points with inner divs, this captures only partial content,
 * potentially under-counting innerHTML length. This is acceptable for POC because:
 * 1. Empty mount points (the target case) have no inner divs
 * 2. Mount points with nested divs already have substantial content (no escalation needed)
 * Production should use a proper HTML parser for accuracy.
 */
const MOUNT_POINT_REGEX = /<div\s+id=["'](root|app|__next)["'][^>]*>([\s\S]*?)<\/div>/i;

/**
 * Regex to extract noscript content.
 * Captures text between <noscript> tags.
 */
const NOSCRIPT_REGEX = /<noscript[^>]*>([\s\S]*?)<\/noscript>/i;

/**
 * Regex to detect structured data (JSON-LD).
 */
const JSONLD_REGEX = /<script\s+type=["']application\/ld\+json["']/i;

/**
 * Regex to detect meta generator tag.
 * Captures the content attribute value.
 */
const META_GENERATOR_REGEX = /<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i;

/**
 * Known framework names for meta generator detection.
 * WHY lowercase comparison: Generator content varies in casing.
 */
const KNOWN_GENERATORS = [
  'next.js',
  'gatsby',
  'hugo',
  'jekyll',
  'nuxt',
  'sveltekit',
  'remix',
  'astro',
  'eleventy',
  'hexo',
  'wordpress',
  'ghost',
];

/**
 * Strip HTML tags to get plain text from an HTML fragment.
 * Used for measuring noscript content length.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Composite scorer that evaluates Go CrawlResult signals
 * to predict whether a page needs browser/LLM escalation.
 *
 * Zero LLM calls — pure heuristic.
 */
export class FailureScorer {
  private readonly threshold: number;
  private readonly weights: Record<string, number>;

  constructor(config?: Partial<FailureScorerConfig>) {
    this.threshold = config?.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD;

    // Merge default weights with any overrides
    this.weights = {
      ...DEFAULT_POSITIVE_WEIGHTS,
      ...DEFAULT_ANTI_WEIGHTS,
      ...config?.weights,
    };
  }

  /**
   * Score a single CrawlResult.
   * Returns detailed signal breakdown + escalation decision.
   */
  score(result: CrawlResult): FailureScoreResult {
    const signals = this.detectPositiveSignals(result);
    const positiveSignals = this.detectAntiSignals(result);

    // Score formula: max(0, min(100, sum of weighted detected signals))
    let rawScore = 0;
    for (const signal of signals) {
      if (signal.detected) {
        rawScore += signal.weight;
      }
    }
    for (const signal of positiveSignals) {
      if (signal.detected) {
        rawScore += signal.weight; // Anti-signal weights are negative
      }
    }

    const score = Math.max(0, Math.min(100, rawScore));
    const shouldEscalate = score >= this.threshold;

    const detectedSignals = signals.filter((s) => s.detected);
    const detectedAntiSignals = positiveSignals.filter((s) => s.detected);

    const reason = this.buildReason(score, shouldEscalate, detectedSignals, detectedAntiSignals);

    log.debug('Scored page', {
      url: result.url,
      score,
      shouldEscalate,
      detectedSignals: detectedSignals.length,
      detectedAntiSignals: detectedAntiSignals.length,
    });

    return {
      score,
      shouldEscalate,
      signals,
      positiveSignals,
      reason,
    };
  }

  /**
   * Score a batch of CrawlResults.
   * Returns per-URL results + aggregate statistics.
   */
  scoreBatch(results: CrawlResult[]): {
    results: Array<{ url: string; score: FailureScoreResult }>;
    stats: { total: number; escalated: number; escalationRate: number };
  } {
    const scored = results.map((r) => ({
      url: r.url,
      score: this.score(r),
    }));

    const total = scored.length;
    const escalated = scored.filter((s) => s.score.shouldEscalate).length;
    // WHY guard against division by zero: empty batch should return 0% rate
    const escalationRate = total > 0 ? escalated / total : 0;

    log.info('Batch scoring complete', { total, escalated, escalationRate });

    return {
      results: scored,
      stats: { total, escalated, escalationRate },
    };
  }

  /**
   * Detect positive signals (indicators that escalation is needed).
   */
  private detectPositiveSignals(result: CrawlResult): FailureSignal[] {
    const html = result.html ?? '';
    const text = result.text ?? '';
    const links = result.links ?? [];

    return [
      this.detectShortText(text),
      this.detectNoLinks(links),
      this.detectEmptyMountPoint(html),
      this.detectHighMarkupRatio(html, text),
      this.detectNoscriptContent(html),
      this.detectFrameworkMarker(html),
    ];
  }

  /**
   * Detect anti-signals (indicators that escalation is NOT needed).
   */
  private detectAntiSignals(result: CrawlResult): FailureSignal[] {
    const html = result.html ?? '';
    const text = result.text ?? '';
    const links = result.links ?? [];

    return [
      this.detectSsrNextData(html, text),
      this.detectSsrContentRich(text, links),
      this.detectStructuredData(html),
      this.detectMetaGenerator(html),
    ];
  }

  private detectShortText(text: string): FailureSignal {
    const detected = text.length < SHORT_TEXT_THRESHOLD;
    return {
      name: 'short_text',
      weight: this.weights['short_text'],
      detected,
      value: text.length,
      threshold: SHORT_TEXT_THRESHOLD,
      description: 'SPAs render empty shells with near-zero text; static pages have content',
    };
  }

  private detectNoLinks(links: CrawlResult['links']): FailureSignal {
    const detected = links.length === 0;
    return {
      name: 'no_links',
      weight: this.weights['no_links'],
      detected,
      value: links.length,
      threshold: 0,
      description: 'Hydrated pages have navigation links; empty shells typically have none',
    };
  }

  private detectEmptyMountPoint(html: string): FailureSignal {
    const match = MOUNT_POINT_REGEX.exec(html);
    let detected = false;
    let innerLength = 0;

    if (match) {
      const innerHTML = (match[2] ?? '').trim();
      innerLength = innerHTML.length;
      detected = innerLength < EMPTY_MOUNT_INNER_THRESHOLD;
    }

    return {
      name: 'empty_mount_point',
      weight: this.weights['empty_mount_point'],
      detected,
      value: match ? innerLength : 'no mount point found',
      threshold: EMPTY_MOUNT_INNER_THRESHOLD,
      description: 'Classic SPA marker — React/Vue/Next.js mount point with no rendered content',
    };
  }

  private detectHighMarkupRatio(html: string, text: string): FailureSignal {
    const ratio = html.length / Math.max(text.length, 1);
    const detected = ratio > HIGH_MARKUP_RATIO_THRESHOLD;
    return {
      name: 'high_markup_ratio',
      weight: this.weights['high_markup_ratio'],
      detected,
      value: Math.round(ratio * 100) / 100,
      threshold: HIGH_MARKUP_RATIO_THRESHOLD,
      description: 'Mostly scripts/styles, little content',
    };
  }

  private detectNoscriptContent(html: string): FailureSignal {
    const match = NOSCRIPT_REGEX.exec(html);
    let detected = false;
    let textLength = 0;

    if (match) {
      const plainText = stripHtmlTags(match[1] ?? '');
      textLength = plainText.length;
      detected = textLength > NOSCRIPT_TEXT_THRESHOLD;
    }

    return {
      name: 'noscript_content',
      weight: this.weights['noscript_content'],
      detected,
      value: textLength,
      threshold: NOSCRIPT_TEXT_THRESHOLD,
      description: 'Site explicitly says "JS required"',
    };
  }

  private detectFrameworkMarker(html: string): FailureSignal {
    const hasNext = html.includes('__NEXT_DATA__');
    const hasNuxt = html.includes('__NUXT__');
    const hasGatsby = html.includes('__GATSBY');
    const detected = hasNext || hasNuxt || hasGatsby;

    const markers: string[] = [];
    if (hasNext) markers.push('__NEXT_DATA__');
    if (hasNuxt) markers.push('__NUXT__');
    if (hasGatsby) markers.push('__GATSBY');

    return {
      name: 'framework_marker',
      weight: this.weights['framework_marker'],
      detected,
      value: markers.length > 0 ? markers.join(', ') : 'none',
      threshold: 'any framework marker present',
      description: 'Known JS framework, but SSR might deliver full HTML',
    };
  }

  private detectSsrNextData(html: string, text: string): FailureSignal {
    const hasNextData = html.includes('__NEXT_DATA__');
    const hasEnoughText = text.length > SSR_TEXT_THRESHOLD;
    const detected = hasNextData && hasEnoughText;

    return {
      name: 'ssr_next_data',
      weight: this.weights['ssr_next_data'],
      detected,
      value: text.length,
      threshold: SSR_TEXT_THRESHOLD,
      description: 'Next.js with SSR — framework marker but content is present',
    };
  }

  private detectSsrContentRich(text: string, links: CrawlResult['links']): FailureSignal {
    const hasEnoughText = text.length > CONTENT_RICH_TEXT_THRESHOLD;
    const hasEnoughLinks = links.length > CONTENT_RICH_LINKS_THRESHOLD;
    const detected = hasEnoughText && hasEnoughLinks;

    return {
      name: 'ssr_content_rich',
      weight: this.weights['ssr_content_rich'],
      detected,
      value: `text=${text.length}, links=${links.length}`,
      threshold: `text>${CONTENT_RICH_TEXT_THRESHOLD}, links>${CONTENT_RICH_LINKS_THRESHOLD}`,
      description: 'Page has real content despite framework markers',
    };
  }

  private detectStructuredData(html: string): FailureSignal {
    const detected = JSONLD_REGEX.test(html);
    return {
      name: 'structured_data',
      weight: this.weights['structured_data'],
      detected,
      value: detected ? 'found' : 'not found',
      threshold: 'application/ld+json script tag present',
      description: 'Structured data = SEO-aware = likely SSR',
    };
  }

  private detectMetaGenerator(html: string): FailureSignal {
    const match = META_GENERATOR_REGEX.exec(html);
    let detected = false;
    let generatorValue = 'none';

    if (match) {
      generatorValue = match[1] ?? '';
      const lower = generatorValue.toLowerCase();
      detected = KNOWN_GENERATORS.some((gen) => lower.includes(gen));
    }

    return {
      name: 'meta_generator',
      weight: this.weights['meta_generator'],
      detected,
      value: generatorValue,
      threshold: 'known framework name in generator meta',
      description: 'Generator meta = build tool rendered the page server-side',
    };
  }

  /**
   * Build a human-readable reason string summarizing the scoring decision.
   */
  private buildReason(
    score: number,
    shouldEscalate: boolean,
    detectedSignals: FailureSignal[],
    detectedAntiSignals: FailureSignal[],
  ): string {
    if (detectedSignals.length === 0 && detectedAntiSignals.length === 0) {
      return `Score ${score}/100: No failure signals detected. Page appears to have normal content.`;
    }

    const signalNames = detectedSignals.map((s) => s.name).join(', ');
    const antiNames = detectedAntiSignals.map((s) => s.name).join(', ');

    const parts: string[] = [`Score ${score}/100.`];

    if (detectedSignals.length > 0) {
      parts.push(`Failure signals: ${signalNames}.`);
    }
    if (detectedAntiSignals.length > 0) {
      parts.push(`SSR evidence: ${antiNames}.`);
    }

    parts.push(shouldEscalate ? 'Recommending browser/LLM escalation.' : 'No escalation needed.');

    return parts.join(' ');
  }
}
