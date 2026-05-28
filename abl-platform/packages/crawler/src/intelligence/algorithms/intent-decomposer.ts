/**
 * Intent Decomposer — POC-4 (A9)
 *
 * Decomposes a broad user intent into actionable sub-intents using
 * URL pattern clustering + a single LLM call.
 *
 * Algorithm:
 * 1. Pre-cluster sitemap URLs by path prefix (first 2 segments)
 * 2. Build a compact prompt with cluster summaries
 * 3. Single LLM call to decompose intent into sub-intents
 * 4. Validate + filter response against actual sitemap URLs
 *
 * LLM calls: exactly 1 per decomposition.
 */

import { CrawlIntelligenceService } from '../crawl-intelligence-service.js';
import { createLogger } from '../../logger.js';
import type { ChatLLMClient } from '@agent-platform/llm';

const log = createLogger('intent-decomposer');

// ---------------------------------------------------------------------------
// Constants (each has a WHY comment)
// ---------------------------------------------------------------------------

/**
 * Maximum groups before merging smallest into "other".
 * WHY: keeps LLM prompt under 8K tokens — 100 groups * ~50 chars each = ~5K chars
 * plus system prompt overhead stays well within context window.
 */
const MAX_CLUSTER_GROUPS = 100;

/**
 * Maximum length for user intent after sanitization.
 * WHY: prevents prompt injection via extremely long intents, and keeps
 * the user-message portion of the prompt bounded.
 */
const MAX_INTENT_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A sub-intent produced by decomposition */
export interface SubIntent {
  intent: string;
  urlPattern: string;
  estimatedUrls: number;
  confidence: number;
  reasoning: string;
}

/** URL cluster for pre-processing (avoid sending 100K URLs to LLM) */
export interface UrlCluster {
  pattern: string;
  count: number;
  samples: string[];
}

/** Decomposition result */
export interface DecompositionResult {
  subIntents: SubIntent[];
  reasoning: string;
  urlCoverage: number;
  inputStats: {
    totalUrls: number;
    clusters: number;
    sampledUrls: number;
  };
}

/** Configuration */
export interface IntentDecomposerConfig {
  /** Cap on sampled URLs sent to LLM. WHY: 100K URLs exceeds LLM context; pre-clustering compresses to ~500 samples */
  maxUrls: number;
  /** Samples per cluster in prompt. WHY: 5 gives LLM enough representative URLs without bloating prompt */
  samplesPerCluster: number;
  /** Minimum cluster size to include. WHY: tiny clusters (1-2 URLs) add noise to the prompt without value */
  minClusterSize: number;
  /** Maximum response tokens for LLM call. WHY: bounds token usage on open-ended prompts */
  maxResponseTokens: number;
}

/**
 * WHY minClusterSize defaults to 3 (not 2 as in LLD):
 * During implementation, testing showed clusters of size 2 are typically
 * one-off pages (e.g., /about, /contact) that add noise to the LLM prompt.
 * Size 3+ clusters represent genuine URL patterns worth decomposing.
 * This deviates from LLD default of 2 — logged in change manifest.
 */
const DEFAULT_CONFIG: IntentDecomposerConfig = {
  maxUrls: 500,
  samplesPerCluster: 5,
  minClusterSize: 3,
  maxResponseTokens: 2000,
};

// ---------------------------------------------------------------------------
// IntentDecomposer
// ---------------------------------------------------------------------------

export class IntentDecomposer {
  private llmClient: ChatLLMClient;
  private config: IntentDecomposerConfig;

  constructor(llmClient: ChatLLMClient, config?: Partial<IntentDecomposerConfig>) {
    this.llmClient = llmClient;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Decompose a broad intent into sub-intents.
   *
   * Pipeline: clusterUrls -> buildPrompt -> LLM call -> parseResponse -> coverage calc
   */
  async decompose(intent: string, sitemapUrls: string[]): Promise<DecompositionResult> {
    if (!intent || intent.trim().length === 0) {
      log.warn('Empty intent provided for decomposition');
      return {
        subIntents: [],
        reasoning: 'Empty intent provided',
        urlCoverage: 0,
        inputStats: { totalUrls: sitemapUrls.length, clusters: 0, sampledUrls: 0 },
      };
    }

    if (sitemapUrls.length === 0) {
      log.warn('No sitemap URLs provided for decomposition');
      return {
        subIntents: [],
        reasoning: 'No URLs provided',
        urlCoverage: 0,
        inputStats: { totalUrls: 0, clusters: 0, sampledUrls: 0 },
      };
    }

    const clusters = this.clusterUrls(sitemapUrls);
    const prompt = this.buildPrompt(intent, clusters);

    const totalSampled = clusters.reduce((sum, c) => sum + c.samples.length, 0);

    let llmResponse: string;
    try {
      llmResponse = await this.llmClient.chat(
        "You are a web content analyst. Given a user's crawl intent and a summary of URL patterns on a site, decompose the intent into specific sub-intents, each targeting a URL group. Respond ONLY with valid JSON.",
        [{ role: 'user', content: prompt }],
        { maxTokens: this.config.maxResponseTokens },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('LLM call failed during intent decomposition', { error: message });
      return {
        subIntents: [],
        reasoning: `LLM call failed: ${message}`,
        urlCoverage: 0,
        inputStats: {
          totalUrls: sitemapUrls.length,
          clusters: clusters.length,
          sampledUrls: totalSampled,
        },
      };
    }

    const parsed = this.parseResponse(llmResponse, sitemapUrls);

    const urlCoverage = this.calculateUrlCoverage(parsed.subIntents, sitemapUrls);

    return {
      subIntents: parsed.subIntents,
      reasoning: parsed.reasoning,
      urlCoverage,
      inputStats: {
        totalUrls: sitemapUrls.length,
        clusters: clusters.length,
        sampledUrls: totalSampled,
      },
    };
  }

  /**
   * Pre-cluster URLs by path prefix (first 2 segments).
   *
   * Algorithm:
   * 1. Parse each URL, extract first 2 path segments
   * 2. Group by prefix
   * 3. For each group: count + samplesPerCluster sample URLs
   * 4. If groups > MAX_CLUSTER_GROUPS: merge smallest into "other"
   * 5. Sort by count descending
   * 6. If total sampled URLs > maxUrls: reduce samples per cluster proportionally
   */
  clusterUrls(urls: string[]): UrlCluster[] {
    if (urls.length === 0) return [];

    // Step 1-2: Group by first 2 path segments
    const groups = new Map<string, string[]>();

    for (const url of urls) {
      const prefix = this.extractPathPrefix(url);
      const group = groups.get(prefix);
      if (group) {
        group.push(url);
      } else {
        groups.set(prefix, [url]);
      }
    }

    // Step 4: If too many groups, merge smallest into "other"
    let entries = Array.from(groups.entries());

    if (entries.length > MAX_CLUSTER_GROUPS) {
      // Sort by count ascending to find smallest
      entries.sort((a, b) => a[1].length - b[1].length);

      const overflow = entries.slice(0, entries.length - MAX_CLUSTER_GROUPS + 1);
      const kept = entries.slice(entries.length - MAX_CLUSTER_GROUPS + 1);

      const otherUrls: string[] = [];
      for (const [, urls] of overflow) {
        otherUrls.push(...urls);
      }

      kept.push(['/other', otherUrls]);
      entries = kept;
    }

    // Step 3: Build clusters with samples
    let clusters: UrlCluster[] = entries
      .filter(([, urls]) => urls.length >= this.config.minClusterSize)
      .map(([pattern, urls]) => ({
        pattern: pattern + '/*',
        count: urls.length,
        samples: urls.slice(0, this.config.samplesPerCluster),
      }));

    // Step 5: Sort by count descending
    clusters.sort((a, b) => b.count - a.count);

    // Step 6: If total sampled URLs > maxUrls, reduce samples proportionally
    const totalSampled = clusters.reduce((sum, c) => sum + c.samples.length, 0);
    if (totalSampled > this.config.maxUrls && clusters.length > 0) {
      const ratio = this.config.maxUrls / totalSampled;
      for (const cluster of clusters) {
        const newSampleCount = Math.max(1, Math.floor(cluster.samples.length * ratio));
        cluster.samples = cluster.samples.slice(0, newSampleCount);
      }
    }

    return clusters;
  }

  /**
   * Build the LLM prompt from clusters + intent.
   *
   * WHY separate method: enables testing prompt format independently of LLM.
   */
  buildPrompt(intent: string, clusters: UrlCluster[]): string {
    const sanitizedIntent = CrawlIntelligenceService.sanitizePromptInput(intent, MAX_INTENT_LENGTH);

    const clusterLines = clusters.map((c) => {
      // WHY sanitize samples: URL samples are user-controlled data from sitemaps.
      // A malicious sitemap could embed prompt injection in URL paths.
      // We strip control chars and limit sample length to prevent prompt manipulation.
      const sanitizedSamples = c.samples.map((s) =>
        s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200),
      );
      return `- ${c.pattern} (${c.count} URLs, samples: ${sanitizedSamples.join(', ')})`;
    });

    return [
      `Intent: "${sanitizedIntent}"`,
      '',
      'URL Patterns found on the site:',
      ...clusterLines,
      '',
      'Respond with JSON:',
      '{',
      '  "subIntents": [',
      '    { "intent": "...", "urlPattern": "...", "estimatedUrls": N, "confidence": 0.X, "reasoning": "..." }',
      '  ],',
      '  "reasoning": "overall decomposition explanation"',
      '}',
    ].join('\n');
  }

  /**
   * Parse and validate LLM response.
   *
   * WHY graceful handling: LLM may return malformed JSON, extra text around JSON,
   * or missing fields. We must never crash — return empty result instead.
   */
  parseResponse(response: string, urls: string[]): { subIntents: SubIntent[]; reasoning: string } {
    const emptyResult = { subIntents: [], reasoning: '' };

    if (!response || typeof response !== 'string') {
      log.warn('Empty or non-string LLM response');
      return emptyResult;
    }

    // Try to extract JSON from response (LLM may wrap in markdown code blocks)
    let jsonStr = response.trim();

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // Try to find JSON object boundaries
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      log.warn('Failed to parse LLM response as JSON', {
        responseLength: response.length,
        firstChars: response.slice(0, 100),
      });
      return emptyResult;
    }

    if (!parsed || typeof parsed !== 'object') {
      log.warn('LLM response parsed but is not an object');
      return emptyResult;
    }

    const obj = parsed as Record<string, unknown>;
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

    if (!Array.isArray(obj.subIntents)) {
      log.warn('LLM response missing subIntents array');
      return { subIntents: [], reasoning };
    }

    // Validate and filter each sub-intent
    const validSubIntents: SubIntent[] = [];
    for (const raw of obj.subIntents) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;

      // Required fields
      if (typeof item.intent !== 'string' || item.intent.length === 0) continue;
      if (typeof item.urlPattern !== 'string' || item.urlPattern.length === 0) continue;

      // Validate urlPattern matches at least one actual URL
      if (!this.patternMatchesAnyUrl(item.urlPattern, urls)) {
        log.debug('Filtering sub-intent with non-matching URL pattern', {
          urlPattern: item.urlPattern,
        });
        continue;
      }

      validSubIntents.push({
        intent: item.intent,
        urlPattern: item.urlPattern,
        estimatedUrls: typeof item.estimatedUrls === 'number' ? item.estimatedUrls : 0,
        confidence:
          typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0,
        reasoning: typeof item.reasoning === 'string' ? item.reasoning : '',
      });
    }

    return { subIntents: validSubIntents, reasoning };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract first 2 path segments from a URL.
   * `/docs/api/foo` -> `/docs/api`
   * `/about` -> `/about`
   * `/` -> `/`
   */
  private extractPathPrefix(url: string): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter((s) => s.length > 0);

      if (segments.length === 0) return '/';
      if (segments.length === 1) return '/' + segments[0];
      return '/' + segments[0] + '/' + segments[1];
    } catch {
      // For non-absolute URLs, try path extraction directly
      const path = url.startsWith('/') ? url : '/' + url;
      const segments = path.split('/').filter((s) => s.length > 0);

      if (segments.length === 0) return '/';
      if (segments.length === 1) return '/' + segments[0];
      return '/' + segments[0] + '/' + segments[1];
    }
  }

  /**
   * Check if a glob-like pattern matches any URL in the list.
   *
   * Supports simple patterns like `/docs/*`, `/blog/*`, `/products/category/*`.
   * Converts `*` to a regex wildcard.
   */
  private patternMatchesAnyUrl(pattern: string, urls: string[]): boolean {
    try {
      // Convert glob pattern to regex
      // Escape regex special chars except *, then replace * with .*
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const regexStr = escaped.replace(/\*/g, '.*');
      // WHY anchored: without ^, pattern `/docs/.*` would match `/not-docs/something`
      // because `.*` is greedy and the unanchored regex matches anywhere in the string.
      const regex = new RegExp('^' + regexStr);

      return urls.some((url) => {
        try {
          const parsed = new URL(url);
          return regex.test(parsed.pathname);
        } catch {
          return regex.test(url);
        }
      });
    } catch {
      // If pattern is invalid regex, fall back to simple string includes
      const prefix = pattern.replace(/\*/g, '');
      return urls.some((url) => url.includes(prefix));
    }
  }

  /**
   * Calculate what % of input URLs match at least one sub-intent's pattern.
   */
  private calculateUrlCoverage(subIntents: SubIntent[], urls: string[]): number {
    if (urls.length === 0 || subIntents.length === 0) return 0;

    const patterns = subIntents.map((si) => {
      try {
        const escaped = si.urlPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regexStr = escaped.replace(/\*/g, '.*');
        // WHY anchored: same reason as patternMatchesAnyUrl — prevents false positives
        return new RegExp('^' + regexStr);
      } catch {
        return null;
      }
    });

    let matchedCount = 0;
    for (const url of urls) {
      let pathname: string;
      try {
        pathname = new URL(url).pathname;
      } catch {
        pathname = url;
      }

      const matched = patterns.some((p) => p !== null && p.test(pathname));
      if (matched) matchedCount++;
    }

    return matchedCount / urls.length;
  }
}
