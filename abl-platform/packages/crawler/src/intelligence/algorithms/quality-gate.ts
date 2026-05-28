/**
 * Quality Gate — evaluates page HTML to score content quality
 * and gate ingestion of low-quality pages (SPA shells, cookie walls, thin pages).
 *
 * Zero LLM calls — pure heuristic scoring using cheerio for HTML parsing.
 *
 * Score formula:
 *   score = 0.4 * contentLengthScore + 0.35 * (1 - boilerplateRatio) + 0.25 * (1 - hiddenRatio)
 *
 * Quality buckets:
 *   score >= 0.7 = 'rich'
 *   0.3 <= score < 0.7 = 'standard'
 *   score < 0.3 = 'thin'
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';

const log = createLogger('quality-gate');

/** Configuration for the quality gate */
export interface QualityGateConfig {
  minContentLength: number; // default 500 chars
  maxBoilerplateRatio: number; // default 0.7
  maxHiddenRatio: number; // default 0.5
  blockThreshold: number; // default 0.3 (composite score)
}

/** A single quality signal detected in the page */
export interface QualitySignal {
  name: 'content_length' | 'boilerplate_ratio' | 'hidden_content' | 'meta_quality';
  score: number; // 0.0–1.0
  value: number;
  threshold: number;
  description: string;
}

/** Quality gate output */
export interface QualityGateResult {
  score: number; // 0.0–1.0 composite
  quality: 'rich' | 'standard' | 'thin';
  shouldBlock: boolean; // score < blockThreshold
  signals: QualitySignal[];
  reason: string; // human-readable summary
  contentLength: number;
  boilerplateRatio: number;
}

const DEFAULT_CONFIG: QualityGateConfig = {
  minContentLength: 500,
  maxBoilerplateRatio: 0.7,
  maxHiddenRatio: 0.5,
  blockThreshold: 0.3,
};

// WHY these weights: Content length is the strongest quality predictor (0.4),
// boilerplate ratio is second (0.35) because nav-heavy pages are common,
// hidden content is the weakest signal (0.25) because some hidden content is
// legitimate (screen-reader text, collapsible sections).
const WEIGHT_CONTENT_LENGTH = 0.4;
const WEIGHT_BOILERPLATE = 0.35;
const WEIGHT_HIDDEN = 0.25;

// WHY 1000: Content length score normalizes to 1.0 at this threshold.
// Pages with 1000+ chars of text are considered to have full content.
const CONTENT_LENGTH_NORMALIZATION = 1000;

// Selectors for boilerplate regions — nav, footer, aside contain
// site-wide chrome, not page-specific content.
const BOILERPLATE_SELECTORS =
  'nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';

// Selectors for hidden content — elements not visible to users but
// inflating the DOM size.
const HIDDEN_SELECTORS =
  '[aria-hidden="true"], [style*="display:none"], [style*="display: none"], .sr-only, .visually-hidden';

/**
 * Scores page quality and gates ingestion of low-quality content.
 *
 * Uses cheerio to parse HTML and compute:
 * - Content length score (normalized to 0-1)
 * - Boilerplate ratio (nav+footer+aside text / total text)
 * - Hidden content ratio (hidden elements / total elements)
 * - Meta quality (title + meta description presence)
 */
export class QualityGate {
  private readonly config: QualityGateConfig;

  constructor(config?: Partial<QualityGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Score a single page's quality.
   * Returns detailed signal breakdown + block decision.
   */
  score(html: string, text: string): QualityGateResult {
    const safeHtml = html ?? '';
    const $ = cheerio.load(safeHtml);
    return this._scoreInternal($, text);
  }

  /**
   * Score a single page's quality using a pre-parsed cheerio DOM.
   * Use this when the caller has already parsed HTML with cheerio
   * to avoid redundant parsing.
   */
  scoreWithDom($: cheerio.CheerioAPI, text: string): QualityGateResult {
    return this._scoreInternal($, text);
  }

  /**
   * Shared implementation for score() and scoreWithDom().
   * All scoring logic lives here.
   */
  private _scoreInternal($: cheerio.CheerioAPI, text: string): QualityGateResult {
    const safeText = text ?? '';

    const contentLengthSignal = this.computeContentLength(safeText);
    const boilerplateSignal = this.computeBoilerplateRatio($, safeText);
    const hiddenSignal = this.computeHiddenContent($);
    const metaSignal = this.computeMetaQuality($);

    const signals: QualitySignal[] = [
      contentLengthSignal,
      boilerplateSignal,
      hiddenSignal,
      metaSignal,
    ];

    // Composite score formula — DEVIATION FROM LLD:
    //   LLD formula:  score = 0.4 * contentLengthScore + 0.35 * (1 - boilerplateRatio) + 0.25 * (1 - hiddenRatio)
    //   Actual:       score = 0.4 * contentGate + 0.35 * (1 - boilerplateRatio) * contentGate + 0.25 * (1 - hiddenRatio) * contentGate
    //
    // WHY content gate multiplier is better than LLD formula: When text is below
    // minContentLength, the LLD formula gives a baseline score of ~0.6 even for empty
    // pages (boilerplate=0 + hidden=0 → 0.35 + 0.25 = 0.6). We use the content length
    // score as a gate — the other signals can only contribute proportionally to how much
    // content actually exists. An empty page cannot be rescued by having low boilerplate
    // ratio. This was an intentional improvement over the LLD spec.
    const boilerplateRatio = boilerplateSignal.value;
    const hiddenRatio = hiddenSignal.value;
    const contentGate = contentLengthSignal.score;
    const rawScore =
      WEIGHT_CONTENT_LENGTH * contentGate +
      WEIGHT_BOILERPLATE * (1 - boilerplateRatio) * contentGate +
      WEIGHT_HIDDEN * (1 - hiddenRatio) * contentGate;

    // Clamp to 0.0–1.0
    const compositeScore = Math.max(0, Math.min(1, rawScore));

    const quality = this.classifyQuality(compositeScore);
    const shouldBlock = compositeScore < this.config.blockThreshold;

    const reason = this.buildReason(compositeScore, quality, shouldBlock, signals);

    log.debug('Scored page quality', {
      contentLength: safeText.length,
      compositeScore,
      quality,
      shouldBlock,
      boilerplateRatio,
    });

    return {
      score: compositeScore,
      quality,
      shouldBlock,
      signals,
      reason,
      contentLength: safeText.length,
      boilerplateRatio,
    };
  }

  /**
   * Score a batch of pages.
   * Returns per-URL results + aggregate statistics.
   */
  scoreBatch(pages: Array<{ url: string; html: string; text: string }>): {
    results: Array<{ url: string; result: QualityGateResult }>;
    stats: { total: number; blocked: number; blockRate: number };
  } {
    const results = pages.map((page) => ({
      url: page.url,
      result: this.score(page.html, page.text),
    }));

    const total = results.length;
    const blocked = results.filter((r) => r.result.shouldBlock).length;
    // WHY guard against division by zero: empty batch should return 0% rate
    const blockRate = total > 0 ? blocked / total : 0;

    log.info('Batch quality scoring complete', { total, blocked, blockRate });

    return {
      results,
      stats: { total, blocked, blockRate },
    };
  }

  /**
   * Compute content length signal.
   * Score normalizes text length against CONTENT_LENGTH_NORMALIZATION.
   */
  private computeContentLength(text: string): QualitySignal {
    const length = text.length;
    // Normalize: 0 at 0 chars, 1.0 at CONTENT_LENGTH_NORMALIZATION+ chars
    const score = Math.min(1, length / CONTENT_LENGTH_NORMALIZATION);

    return {
      name: 'content_length',
      score,
      value: length,
      threshold: this.config.minContentLength,
      description:
        length < this.config.minContentLength
          ? `Text length ${length} is below minimum ${this.config.minContentLength} chars`
          : `Text length ${length} meets minimum content threshold`,
    };
  }

  /**
   * Compute boilerplate ratio using cheerio.
   * Boilerplate = text inside nav, footer, aside elements.
   * Ratio = boilerplate text length / total text length.
   */
  private computeBoilerplateRatio($: cheerio.CheerioAPI, text: string): QualitySignal {
    const totalTextLength = text.length;

    if (totalTextLength === 0) {
      return {
        name: 'boilerplate_ratio',
        score: 0,
        value: 0,
        threshold: this.config.maxBoilerplateRatio,
        description: 'No text content to measure boilerplate ratio',
      };
    }

    // Extract text from boilerplate regions
    let boilerplateTextLength = 0;
    $(BOILERPLATE_SELECTORS).each((_i, el) => {
      boilerplateTextLength += $(el).text().trim().length;
    });

    const ratio = Math.min(1, boilerplateTextLength / totalTextLength);

    return {
      name: 'boilerplate_ratio',
      score: 1 - ratio, // Higher is better (less boilerplate)
      value: ratio,
      threshold: this.config.maxBoilerplateRatio,
      description:
        ratio > this.config.maxBoilerplateRatio
          ? `Boilerplate ratio ${(ratio * 100).toFixed(1)}% exceeds ${this.config.maxBoilerplateRatio * 100}% threshold`
          : `Boilerplate ratio ${(ratio * 100).toFixed(1)}% is within acceptable range`,
    };
  }

  /**
   * Compute hidden content ratio using cheerio.
   * Counts elements matching hidden selectors vs total elements.
   */
  private computeHiddenContent($: cheerio.CheerioAPI): QualitySignal {
    const totalElements = $('*').length;

    if (totalElements === 0) {
      return {
        name: 'hidden_content',
        score: 0,
        value: 0,
        threshold: this.config.maxHiddenRatio,
        description: 'No elements to measure hidden content ratio',
      };
    }

    const hiddenElements = $(HIDDEN_SELECTORS).length;
    const ratio = hiddenElements / totalElements;

    return {
      name: 'hidden_content',
      score: 1 - ratio, // Higher is better (less hidden content)
      value: ratio,
      threshold: this.config.maxHiddenRatio,
      description:
        ratio > this.config.maxHiddenRatio
          ? `Hidden content ratio ${(ratio * 100).toFixed(1)}% exceeds ${this.config.maxHiddenRatio * 100}% threshold`
          : `${hiddenElements} of ${totalElements} elements are hidden (${(ratio * 100).toFixed(1)}%)`,
    };
  }

  /**
   * Compute meta quality signal.
   * Checks for <title> and <meta name="description"> presence.
   * Score: 0 (neither), 0.5 (one), 1.0 (both).
   */
  private computeMetaQuality($: cheerio.CheerioAPI): QualitySignal {
    const hasTitle = $('title').text().trim().length > 0;
    const hasDescription = $('meta[name="description"]').attr('content')?.trim()?.length
      ? true
      : false;

    let score = 0;
    if (hasTitle) score += 0.5;
    if (hasDescription) score += 0.5;

    return {
      name: 'meta_quality',
      score,
      value: score,
      threshold: 0.5,
      description: `Meta quality: ${hasTitle ? 'has title' : 'missing title'}, ${hasDescription ? 'has description' : 'missing description'}`,
    };
  }

  /**
   * Classify quality bucket from composite score.
   */
  private classifyQuality(score: number): 'rich' | 'standard' | 'thin' {
    if (score >= 0.7) return 'rich';
    if (score >= 0.3) return 'standard';
    return 'thin';
  }

  /**
   * Build a human-readable reason string summarizing the quality decision.
   */
  private buildReason(
    score: number,
    quality: 'rich' | 'standard' | 'thin',
    shouldBlock: boolean,
    signals: QualitySignal[],
  ): string {
    const scorePercent = (score * 100).toFixed(1);
    const parts: string[] = [`Quality score ${scorePercent}% (${quality}).`];

    const lowSignals = signals.filter((s) => s.score < 0.5);
    if (lowSignals.length > 0) {
      const names = lowSignals.map((s) => s.name).join(', ');
      parts.push(`Low signals: ${names}.`);
    }

    parts.push(shouldBlock ? 'Page blocked from ingestion.' : 'Page passes quality gate.');

    return parts.join(' ');
  }
}
