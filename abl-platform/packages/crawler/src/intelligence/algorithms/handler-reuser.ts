/**
 * Handler Reuse via Template Match.
 *
 * Algorithm:
 * 1. Register known handlers by their SimHash fingerprint
 * 2. When a new page arrives, fingerprint it and find the best match (Hamming <= 3)
 * 3. If matched, reuse the stored handler — skip Phase 2 (UNDERSTAND) and Phase 3 (BUILD HANDLER)
 * 4. Measure extraction quality via Jaccard similarity and field completeness
 *
 * Zero LLM calls when a template match is found.
 */

import { TemplateFingerprinter } from './template-fingerprinter.js';
import type { IPageHandler } from '../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('handler-reuser');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum Hamming distance to consider a fingerprint match.
 * WHY 3: aligned with TemplateFingerprinter's SAME_TEMPLATE_THRESHOLD.
 * At 4+ bits the DOM structure is meaningfully different and the handler
 * likely won't extract correctly.
 */
const MATCH_THRESHOLD = 3;

/**
 * Default maximum entries in the handler library.
 * WHY 1000: CLAUDE.md requires bounded in-memory structures with max size.
 * 1000 templates covers a large site crawl while capping memory to ~1-2 MB
 * (each entry stores a handler object + metadata).
 */
const DEFAULT_MAX_LIBRARY_SIZE = 1000;

/**
 * Default TTL for handler entries in milliseconds (1 hour).
 * WHY 1 hour: CLAUDE.md requires TTL on all in-memory data. Handlers for
 * templates that haven't been accessed in an hour are stale — the site may
 * have changed. 1 hour balances reuse across a typical crawl session.
 * WHY sliding-window (lastAccessedAt, not createdAt): frequently-matched templates
 * should stay alive as long as they're actively being reused. A fixed TTL from
 * createdAt would evict heavily-used handlers mid-crawl.
 */
const DEFAULT_TTL_MS = 3600000;

/**
 * Number of LLM calls saved when a handler is reused.
 * WHY 2: Phase 2 (UNDERSTAND) uses 1 LLM call and Phase 3 (BUILD HANDLER)
 * uses 1 LLM call. Reusing a handler skips both.
 */
const LLM_CALLS_SAVED_ON_REUSE = 2;

/**
 * Weight for completeness in overall quality score.
 * WHY 0.4: completeness (having all fields) is important but less than
 * accuracy (correct values). A handler that extracts all fields with wrong
 * values is worse than one that extracts fewer fields correctly.
 */
const COMPLETENESS_WEIGHT = 0.4;

/**
 * Weight for accuracy in overall quality score.
 * WHY 0.6: accuracy is weighted higher because wrong extracted data pollutes
 * downstream pipelines. Missing fields can be detected and retried.
 */
const ACCURACY_WEIGHT = 0.6;

/**
 * Weight for title match in accuracy calculation.
 * WHY 0.3: title is a single field — important for identification but body
 * contains the bulk of useful content.
 */
const TITLE_ACCURACY_WEIGHT = 0.3;

/**
 * Weight for body Jaccard similarity in accuracy calculation.
 * WHY 0.7: body contains the main content and is the primary extraction target.
 */
const BODY_ACCURACY_WEIGHT = 0.7;

/**
 * Number of hex characters used from fingerprint for templateId.
 * WHY 8: 8 hex chars = 32 bits of the fingerprint, giving ~4 billion unique IDs.
 * Sufficient for the 1000-entry library cap with negligible collision probability.
 */
const TEMPLATE_ID_HEX_LENGTH = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A known template with its associated handler */
export interface TemplateHandlerEntry {
  templateId: string;
  fingerprint: bigint;
  handler: IPageHandler;
  trainedOn: string[]; // URLs used to generate this handler
  createdAt: string; // ISO 8601
  lastAccessedAt: string; // ISO 8601 — for LRU eviction
}

/** Configuration for HandlerReuser */
export interface HandlerReuserConfig {
  /** Max entries in library. WHY: CLAUDE.md requires bounded in-memory structures. Default 1000. */
  maxLibrarySize: number;
  /** TTL in ms. WHY: CLAUDE.md requires TTL on all in-memory data. Default 3600000 (1hr). */
  ttl: number;
}

/** Match result */
export interface HandlerMatchResult {
  matched: boolean;
  templateId?: string;
  handler?: IPageHandler;
  hammingDistance?: number;
  similarity?: number;
  matchedAgainst?: string; // which template was matched
}

/** Extraction quality measurement */
export interface ExtractionQuality {
  completeness: number; // 0.0-1.0 — % of expected fields present
  accuracy: number; // 0.0-1.0 — title exact match + body Jaccard similarity
  overall: number; // weighted average (completeness * 0.4 + accuracy * 0.6)
}

/** Reuse result */
export interface HandlerReuseResult {
  matched: boolean;
  templateId?: string;
  handler?: IPageHandler;
  quality?: ExtractionQuality;
  skippedPhases: string[]; // ["Phase 2", "Phase 3"] if reused
  llmCallsSaved: number; // estimated LLM calls avoided
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Handler Reuser — matches new pages against known templates to skip LLM calls.
 *
 * Maintains a bounded, TTL-evicted library of template-handler pairs.
 * Uses TemplateFingerprinter for SimHash-based template matching.
 */
export class HandlerReuser {
  private entries: Map<string, TemplateHandlerEntry>;
  private fingerprinter: TemplateFingerprinter;
  private config: HandlerReuserConfig;

  constructor(fingerprinter: TemplateFingerprinter, config?: Partial<HandlerReuserConfig>) {
    this.entries = new Map();
    this.fingerprinter = fingerprinter;
    this.config = {
      maxLibrarySize: config?.maxLibrarySize ?? DEFAULT_MAX_LIBRARY_SIZE,
      ttl: config?.ttl ?? DEFAULT_TTL_MS,
    };
  }

  /**
   * Register a handler for a known template.
   *
   * Generates templateId from fingerprint hex prefix.
   * Evicts expired entries first, then LRU if library is full.
   */
  registerHandler(fingerprint: bigint, handler: IPageHandler, trainedOn: string[]): void {
    // Evict expired entries before checking capacity
    this.evictExpired();

    const hexStr = fingerprint.toString(16).padStart(16, '0');
    const templateId = `tpl-${hexStr.slice(0, TEMPLATE_ID_HEX_LENGTH)}`;
    const now = new Date().toISOString();

    // If library is full after evicting expired, evict LRU
    if (this.entries.size >= this.config.maxLibrarySize && !this.entries.has(templateId)) {
      this.evictLRU();
    }

    const entry: TemplateHandlerEntry = {
      templateId,
      fingerprint,
      handler,
      trainedOn,
      createdAt: now,
      lastAccessedAt: now,
    };

    this.entries.set(templateId, entry);

    log.info('Registered handler for template', {
      templateId,
      trainedOn,
      librarySize: this.entries.size,
    });
  }

  /**
   * Match a new page against the library.
   *
   * Fingerprints the HTML, iterates all non-expired entries, and finds the
   * best match with Hamming distance <= MATCH_THRESHOLD.
   */
  match(html: string): HandlerMatchResult {
    let pageFingerprint;
    try {
      pageFingerprint = this.fingerprinter.fingerprint(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to fingerprint HTML for matching', { error: message });
      return { matched: false };
    }

    let bestEntry: TemplateHandlerEntry | undefined;
    let bestDistance = MATCH_THRESHOLD + 1;

    const now = Date.now();

    for (const entry of this.entries.values()) {
      // Skip expired entries
      const entryAge = now - new Date(entry.lastAccessedAt).getTime();
      if (entryAge > this.config.ttl) {
        continue;
      }

      const distance = TemplateFingerprinter.hammingDistance(
        pageFingerprint.fingerprint,
        entry.fingerprint,
      );

      if (distance <= MATCH_THRESHOLD && distance < bestDistance) {
        bestEntry = entry;
        bestDistance = distance;
      }
    }

    if (bestEntry === undefined) {
      return { matched: false };
    }

    // Update lastAccessedAt on match
    bestEntry.lastAccessedAt = new Date().toISOString();

    const similarity = 1 - bestDistance / 64;

    log.info('Matched page against template', {
      templateId: bestEntry.templateId,
      hammingDistance: bestDistance,
      similarity,
    });

    return {
      matched: true,
      templateId: bestEntry.templateId,
      handler: bestEntry.handler,
      hammingDistance: bestDistance,
      similarity,
      matchedAgainst: bestEntry.templateId,
    };
  }

  /**
   * Full reuse pipeline: match + quality report.
   *
   * If matched, returns skippedPhases and estimated LLM calls saved.
   */
  tryReuse(html: string): HandlerReuseResult {
    const matchResult = this.match(html);

    if (!matchResult.matched) {
      return {
        matched: false,
        skippedPhases: [],
        llmCallsSaved: 0,
      };
    }

    return {
      matched: true,
      templateId: matchResult.templateId,
      handler: matchResult.handler,
      skippedPhases: ['Phase 2', 'Phase 3'],
      llmCallsSaved: LLM_CALLS_SAVED_ON_REUSE,
    };
  }

  /**
   * Measure extraction quality (reused handler output vs expected output).
   *
   * Completeness: fraction of expected fields that are present and non-empty.
   * Accuracy: weighted combination of title exact match and body Jaccard similarity.
   * Overall: weighted average of completeness and accuracy.
   */
  static measureQuality(
    extracted: { title?: string; body: string; metadata?: Record<string, string> },
    expected: { title?: string; body: string; metadata?: Record<string, string> },
  ): ExtractionQuality {
    // --- Completeness ---
    // Count expected fields and how many are present in extracted
    let expectedFieldCount = 0;
    let presentFieldCount = 0;

    // Body is always expected
    expectedFieldCount++;
    if (extracted.body && extracted.body.trim().length > 0) {
      presentFieldCount++;
    }

    // Title — only count if expected has a title
    if (expected.title !== undefined && expected.title.length > 0) {
      expectedFieldCount++;
      if (extracted.title !== undefined && extracted.title.trim().length > 0) {
        presentFieldCount++;
      }
    }

    // Metadata keys
    if (expected.metadata) {
      for (const key of Object.keys(expected.metadata)) {
        expectedFieldCount++;
        if (
          extracted.metadata !== undefined &&
          extracted.metadata[key] !== undefined &&
          extracted.metadata[key].trim().length > 0
        ) {
          presentFieldCount++;
        }
      }
    }

    const completeness = expectedFieldCount > 0 ? presentFieldCount / expectedFieldCount : 1.0;

    // --- Accuracy ---
    // Title match: 1.0 if exact match, 0.0 otherwise
    let titleScore: number;
    const bothHaveTitle =
      expected.title !== undefined &&
      expected.title.length > 0 &&
      extracted.title !== undefined &&
      extracted.title.length > 0;
    const neitherHasTitle =
      (expected.title === undefined || expected.title.length === 0) &&
      (extracted.title === undefined || extracted.title.length === 0);

    if (neitherHasTitle) {
      // Both missing — title doesn't factor into accuracy
      titleScore = -1; // sentinel: skip title in weighting
    } else if (bothHaveTitle) {
      titleScore = extracted.title === expected.title ? 1.0 : 0.0;
    } else {
      titleScore = 0.0;
    }

    // Body Jaccard similarity
    const bodyJaccard = HandlerReuser.jaccardSimilarity(extracted.body, expected.body);

    let accuracy: number;
    if (titleScore === -1) {
      // No title to compare — accuracy is body Jaccard only
      accuracy = bodyJaccard;
    } else {
      accuracy = titleScore * TITLE_ACCURACY_WEIGHT + bodyJaccard * BODY_ACCURACY_WEIGHT;
    }

    // --- Overall ---
    const overall = completeness * COMPLETENESS_WEIGHT + accuracy * ACCURACY_WEIGHT;

    return { completeness, accuracy, overall };
  }

  /**
   * Jaccard similarity between two strings at word level.
   *
   * Words are split on whitespace, lowercased for comparison.
   * Returns |intersection| / |union|, or 1.0 if both empty.
   */
  static jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0),
    );
    const setB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0),
    );

    // Both empty
    if (setA.size === 0 && setB.size === 0) {
      return 1.0;
    }

    // One empty
    if (setA.size === 0 || setB.size === 0) {
      return 0.0;
    }

    let intersectionSize = 0;
    for (const word of setA) {
      if (setB.has(word)) {
        intersectionSize++;
      }
    }

    const unionSize = setA.size + setB.size - intersectionSize;
    return unionSize > 0 ? intersectionSize / unionSize : 0.0;
  }

  /**
   * Evict expired entries (older than TTL based on lastAccessedAt).
   */
  private evictExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.entries) {
      const entryAge = now - new Date(entry.lastAccessedAt).getTime();
      if (entryAge > this.config.ttl) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.entries.delete(key);
    }

    if (expiredKeys.length > 0) {
      log.info('Evicted expired entries', {
        evictedCount: expiredKeys.length,
        remainingSize: this.entries.size,
      });
    }
  }

  /**
   * Evict the LRU entry (oldest lastAccessedAt).
   */
  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      const accessTime = new Date(entry.lastAccessedAt).getTime();
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      log.info('Evicted LRU entry', {
        templateId: evicted?.templateId,
        lastAccessedAt: evicted?.lastAccessedAt,
        remainingSize: this.entries.size,
      });
    }
  }

  /**
   * Get library stats for monitoring and debugging.
   */
  getStats(): { size: number; maxSize: number; templateCount: number; expiredCount: number } {
    const now = Date.now();
    let expiredCount = 0;

    for (const entry of this.entries.values()) {
      const entryAge = now - new Date(entry.lastAccessedAt).getTime();
      if (entryAge > this.config.ttl) {
        expiredCount++;
      }
    }

    return {
      size: this.entries.size,
      maxSize: this.config.maxLibrarySize,
      templateCount: this.entries.size,
      expiredCount,
    };
  }
}
