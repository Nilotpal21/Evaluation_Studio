/**
 * Extraction Cascade
 *
 * Tries multiple extraction strategies in order, scoring each with QualityGate.
 * First result scoring >= threshold wins. If all fail, returns the best attempt.
 *
 * Layers (in order):
 *   1. Readability — Mozilla Readability article extraction
 *   2. Semantic HTML — extract from <article>, <main>, [role="main"]
 *   3. Body fallback — strip scripts/styles, keep body text
 *
 * JSON-LD extraction is handled upstream in the crawl worker (pre-ingestion)
 * and doesn't need to be part of this cascade.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '@abl/compiler/platform';
import { readabilityService } from '../readability/index.js';
import type { ReadabilityResult, ReadabilityMetadata } from '../readability/index.js';

const logger = createLogger('extraction-cascade');

// ─── Types ──────────────────────────────────────────────────────────

export interface ExtractionCascadeResult {
  /** Cleaned HTML output (best extraction) */
  cleanedHTML: string;
  /** Which layer produced the winning extraction */
  layer: ExtractionLayer;
  /** Quality score (0–1) from QualityGate heuristic */
  qualityScore: number;
  /** Quality bucket */
  quality: 'rich' | 'standard' | 'thin';
  /** Metadata from extraction */
  metadata: ReadabilityMetadata;
  /** Whether the winning extraction was above the acceptance threshold */
  accepted: boolean;
  /** Per-layer attempt details (for debugging) */
  attempts: ExtractionAttempt[];
}

export type ExtractionLayer = 'readability' | 'semantic' | 'body-fallback';

export interface ExtractionAttempt {
  layer: ExtractionLayer;
  score: number;
  quality: 'rich' | 'standard' | 'thin';
  contentLength: number;
  accepted: boolean;
}

export interface ExtractionCascadeConfig {
  /** Minimum quality score to accept an extraction (0–1). Default: 0.5 */
  acceptThreshold: number;
}

const DEFAULT_CONFIG: ExtractionCascadeConfig = {
  acceptThreshold: 0.5,
};

// ─── Quality Scoring (inline, no external dependency) ──────────────
// Mirrors QualityGate logic from packages/crawler without importing it
// (avoids circular dependency between apps/search-ai and packages/crawler)

interface QualityScore {
  score: number;
  quality: 'rich' | 'standard' | 'thin';
  contentLength: number;
  boilerplateRatio: number;
}

function scoreExtraction(html: string): QualityScore {
  const $ = cheerio.load(html);

  // Content length signal
  const text = $.text();
  const contentLength = text.trim().length;
  const contentGate = Math.min(contentLength / 1000, 1);

  // Boilerplate ratio: text inside nav/footer/aside vs total
  const boilerplateSelectors = [
    'nav',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    'header',
  ];
  let boilerplateLength = 0;
  for (const sel of boilerplateSelectors) {
    $(sel).each((_, el) => {
      boilerplateLength += $(el).text().trim().length;
    });
  }
  const boilerplateRatio = contentLength > 0 ? Math.min(boilerplateLength / contentLength, 1) : 0;

  // Composite score
  const score =
    0.4 * contentGate + 0.35 * (1 - boilerplateRatio) * contentGate + 0.25 * contentGate;
  const quality: 'rich' | 'standard' | 'thin' =
    score >= 0.7 ? 'rich' : score >= 0.3 ? 'standard' : 'thin';

  return { score, quality, contentLength, boilerplateRatio };
}

// ─── Extraction Layers ──────────────────────────────────────────────

function extractReadability(
  rawHTML: string,
  url: string,
  siteType?: 'static' | 'spa' | 'hybrid' | 'unknown',
): { html: string; metadata: ReadabilityMetadata } | null {
  try {
    const result: ReadabilityResult = readabilityService.cleanHTML(rawHTML, url, siteType);
    if (!result.success && !result.cleanedHTML) return null;
    return { html: result.cleanedHTML, metadata: result.metadata };
  } catch {
    return null;
  }
}

function extractSemantic(rawHTML: string): { html: string; metadata: ReadabilityMetadata } | null {
  try {
    const $ = cheerio.load(rawHTML);

    // Try semantic content containers in priority order
    const selectors = [
      'main [role="main"]',
      '[role="main"]',
      'main',
      'article',
      '#content',
      '.content',
      '#main-content',
      '.main-content',
    ];

    for (const selector of selectors) {
      const el = $(selector).first();
      if (el.length === 0) continue;

      const contentHtml = el.html();
      if (!contentHtml || contentHtml.trim().length < 200) continue;

      // Strip scripts and styles from the extracted content
      const $content = cheerio.load(contentHtml);
      $content('script, style, noscript').remove();
      const cleanedContent = $content.html() ?? '';

      if (cleanedContent.trim().length < 100) continue;

      const title = $('title').text().trim() || $('h1').first().text().trim() || '';
      const textLength = $content.text().trim().length;

      return {
        html: cleanedContent,
        metadata: {
          title,
          contentLength: cleanedContent.length,
          textContentLength: textLength,
          cleaned: true,
          sizeReduction: Math.round(
            ((rawHTML.length - cleanedContent.length) / rawHTML.length) * 100,
          ),
          originalSize: Buffer.byteLength(rawHTML, 'utf-8'),
          cleanedSize: Buffer.byteLength(cleanedContent, 'utf-8'),
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}

function extractBodyFallback(rawHTML: string): { html: string; metadata: ReadabilityMetadata } {
  const $ = cheerio.load(rawHTML);

  // Remove non-content elements
  $('script, style, noscript, svg, iframe, link[rel="stylesheet"]').remove();
  $(
    'nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"]',
  ).remove();
  // Remove hidden elements
  $('[aria-hidden="true"], [style*="display:none"], [style*="display: none"]').remove();
  // Remove comments
  $('*')
    .contents()
    .filter(function () {
      return this.type === 'comment';
    })
    .remove();

  const body = $('body').html() ?? $.html() ?? rawHTML;
  const title = $('title').text().trim() || $('h1').first().text().trim() || '';
  const textLength = $.text().trim().length;

  return {
    html: body,
    metadata: {
      title,
      contentLength: body.length,
      textContentLength: textLength,
      cleaned: true,
      sizeReduction: Math.round(((rawHTML.length - body.length) / rawHTML.length) * 100),
      originalSize: Buffer.byteLength(rawHTML, 'utf-8'),
      cleanedSize: Buffer.byteLength(body, 'utf-8'),
    },
  };
}

// ─── Cascade Orchestrator ───────────────────────────────────────────

export function runExtractionCascade(
  rawHTML: string,
  url: string,
  siteType?: 'static' | 'spa' | 'hybrid' | 'unknown',
  config?: Partial<ExtractionCascadeConfig>,
): ExtractionCascadeResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const attempts: ExtractionAttempt[] = [];

  type CascadeCandidate = {
    html: string;
    metadata: ReadabilityMetadata;
    layer: ExtractionLayer;
    score: QualityScore;
  };
  let bestResult: CascadeCandidate | null = null;

  function updateBest(candidate: CascadeCandidate): void {
    if (!bestResult || candidate.score.score > bestResult.score.score) {
      bestResult = candidate;
    }
  }

  // Layer 1: Readability
  const readabilityResult = extractReadability(rawHTML, url, siteType);
  if (readabilityResult) {
    const score = scoreExtraction(readabilityResult.html);
    const accepted = score.score >= cfg.acceptThreshold;
    attempts.push({
      layer: 'readability',
      score: score.score,
      quality: score.quality,
      contentLength: score.contentLength,
      accepted,
    });

    updateBest({
      html: readabilityResult.html,
      metadata: readabilityResult.metadata,
      layer: 'readability',
      score,
    });

    if (accepted) {
      logger.debug('Extraction cascade accepted at readability layer', {
        url,
        score: score.score,
        contentLength: score.contentLength,
      });
      return buildResult(
        readabilityResult.html,
        'readability',
        score,
        readabilityResult.metadata,
        true,
        attempts,
      );
    }
  }

  // Layer 2: Semantic HTML
  const semanticResult = extractSemantic(rawHTML);
  if (semanticResult) {
    const score = scoreExtraction(semanticResult.html);
    const accepted = score.score >= cfg.acceptThreshold;
    attempts.push({
      layer: 'semantic',
      score: score.score,
      quality: score.quality,
      contentLength: score.contentLength,
      accepted,
    });

    updateBest({
      html: semanticResult.html,
      metadata: semanticResult.metadata,
      layer: 'semantic',
      score,
    });

    if (accepted) {
      logger.debug('Extraction cascade accepted at semantic layer', {
        url,
        score: score.score,
        contentLength: score.contentLength,
      });
      return buildResult(
        semanticResult.html,
        'semantic',
        score,
        semanticResult.metadata,
        true,
        attempts,
      );
    }
  }

  // Layer 3: Body fallback (always produces output)
  const bodyResult = extractBodyFallback(rawHTML);
  const bodyScore = scoreExtraction(bodyResult.html);
  const bodyAccepted = bodyScore.score >= cfg.acceptThreshold;
  attempts.push({
    layer: 'body-fallback',
    score: bodyScore.score,
    quality: bodyScore.quality,
    contentLength: bodyScore.contentLength,
    accepted: bodyAccepted,
  });

  updateBest({
    html: bodyResult.html,
    metadata: bodyResult.metadata,
    layer: 'body-fallback',
    score: bodyScore,
  });

  if (bodyAccepted) {
    return buildResult(
      bodyResult.html,
      'body-fallback',
      bodyScore,
      bodyResult.metadata,
      true,
      attempts,
    );
  }

  // No layer met threshold — return the best attempt
  // bestResult is guaranteed non-null because body-fallback always produces output
  const best = bestResult!;
  logger.warn('Extraction cascade: no layer met quality threshold', {
    url,
    bestLayer: best.layer,
    bestScore: best.score.score,
    attempts: attempts.length,
  });

  return buildResult(best.html, best.layer, best.score, best.metadata, false, attempts);
}

function buildResult(
  html: string,
  layer: ExtractionLayer,
  score: QualityScore,
  metadata: ReadabilityMetadata,
  accepted: boolean,
  attempts: ExtractionAttempt[],
): ExtractionCascadeResult {
  return {
    cleanedHTML: html,
    layer,
    qualityScore: score.score,
    quality: score.quality,
    metadata,
    accepted,
    attempts,
  };
}
