/**
 * Query Log Analysis Service
 *
 * Reads historical search queries from ClickHouse and extracts
 * high-frequency domain terms as vocabulary candidates.
 *
 * DESIGN DECISIONS:
 * - Reads from ClickHouse (search_queries table) — written by search-ai-runtime
 * - Stores candidates in MongoDB (VocabularyCandidates) — consumed by vocabulary generation
 * - Stateless: no in-memory caches, all state in DB
 * - Graceful degradation: returns empty result if ClickHouse unavailable
 */

import type { ClickHouseClient } from '@clickhouse/client';
import type { IVocabularyCandidates, ITermCandidate } from '@agent-platform/database/models';
import { filterStopwords } from '@agent-platform/search-ai-internal/canonical';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../../db/index.js';

const VocabularyCandidates = getLazyModel<IVocabularyCandidates>('VocabularyCandidates');

const logger = createLogger('query-log-analysis-service');

// ─── Constants ────────────────────────────────────────────────────────────

const MIN_QUERY_COUNT = 100; // Minimum queries before analysis is meaningful
const MIN_TERM_FREQUENCY = 5; // Minimum occurrences to qualify as candidate
const MAX_CANDIDATES = 200; // Cap on number of candidates per analysis
const MAX_COOCCURRENCES = 10; // Top co-occurring terms per candidate
const MAX_SAMPLE_QUERIES = 5; // Sample queries stored per candidate
const TTL_DAYS = 7; // Candidates expire after 7 days

// ─── Types ────────────────────────────────────────────────────────────────

export interface QueryLogAnalysisResult {
  candidates: ITermCandidate[];
  totalQueries: number;
  uniqueTerms: number;
}

export interface QueryLogAnalysisOptions {
  tenantId: string;
  indexId: string;
  knowledgeBaseId: string;
  /** Override minimum query count (for testing) */
  minQueryCount?: number;
  /** Override minimum term frequency (for testing) */
  minTermFrequency?: number;
  /** Lookback window in days (default: 30) */
  lookbackDays?: number;
}

interface RawQueryRow {
  query_text: string;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class QueryLogAnalysisService {
  private readonly clickhouse: ClickHouseClient;

  constructor(clickhouse: ClickHouseClient) {
    this.clickhouse = clickhouse;
  }

  /**
   * Analyze query logs and produce vocabulary candidates.
   *
   * Steps:
   * 1. Fetch raw query texts from ClickHouse
   * 2. Tokenize and filter stopwords
   * 3. Count term frequencies
   * 4. Calculate co-occurrence statistics
   * 5. Store candidates in MongoDB with TTL
   */
  async analyze(options: QueryLogAnalysisOptions): Promise<QueryLogAnalysisResult> {
    const {
      tenantId,
      indexId,
      knowledgeBaseId,
      minQueryCount = MIN_QUERY_COUNT,
      minTermFrequency = MIN_TERM_FREQUENCY,
      lookbackDays = 30,
    } = options;

    // Step 1: Fetch query texts from ClickHouse
    let queryTexts: string[];
    try {
      queryTexts = await this.fetchQueryTexts(tenantId, indexId, lookbackDays);
    } catch (error) {
      logger.warn('ClickHouse unavailable for query log analysis, returning empty result', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { candidates: [], totalQueries: 0, uniqueTerms: 0 };
    }

    if (queryTexts.length < minQueryCount) {
      logger.info('Insufficient query history for analysis', {
        tenantId,
        indexId,
        queryCount: queryTexts.length,
        minRequired: minQueryCount,
      });
      return { candidates: [], totalQueries: queryTexts.length, uniqueTerms: 0 };
    }

    // Step 2: Tokenize all queries and filter stopwords
    const tokenizedQueries = queryTexts.map((text) => {
      const tokens = tokenize(text);
      return filterStopwords(tokens);
    });

    // Step 3: Count term frequencies
    const termFrequency = new Map<string, number>(); // term → total occurrences
    const termQueryCount = new Map<string, number>(); // term → distinct queries
    const termSamples = new Map<string, string[]>(); // term → sample queries

    for (let i = 0; i < tokenizedQueries.length; i++) {
      const tokens = tokenizedQueries[i];
      const uniqueInQuery = new Set(tokens);

      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }

      for (const token of uniqueInQuery) {
        termQueryCount.set(token, (termQueryCount.get(token) ?? 0) + 1);

        // Collect sample queries (up to MAX_SAMPLE_QUERIES)
        const samples = termSamples.get(token) ?? [];
        if (samples.length < MAX_SAMPLE_QUERIES) {
          samples.push(queryTexts[i]);
          termSamples.set(token, samples);
        }
      }
    }

    // Step 4: Filter by minimum frequency
    const qualifiedTerms = [...termFrequency.entries()]
      .filter(([, freq]) => freq >= minTermFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CANDIDATES);

    // Step 5: Calculate co-occurrence statistics
    const coOccurrenceMap = this.buildCoOccurrenceMap(
      tokenizedQueries,
      new Set(qualifiedTerms.map(([term]) => term)),
    );

    // Step 6: Build candidates
    const candidates: ITermCandidate[] = qualifiedTerms.map(([term, frequency]) => ({
      term,
      frequency,
      queryCount: termQueryCount.get(term) ?? 0,
      fieldAffinity: null, // Set by downstream LLM analysis (Story 4.2)
      coOccurrences: (coOccurrenceMap.get(term) ?? [])
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_COOCCURRENCES),
      sampleQueries: termSamples.get(term) ?? [],
    }));

    // Step 7: Persist to MongoDB with TTL
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TTL_DAYS);

    await VocabularyCandidates.findOneAndUpdate(
      { tenantId, indexId },
      {
        tenantId,
        indexId,
        knowledgeBaseId,
        totalQueriesAnalyzed: queryTexts.length,
        uniqueTermsExtracted: candidates.length,
        candidates,
        analysisTimestamp: new Date(),
        expiresAt,
      },
      { upsert: true, new: true },
    );

    logger.info('Query log analysis completed', {
      tenantId,
      indexId,
      totalQueries: queryTexts.length,
      uniqueTerms: candidates.length,
    });

    return {
      candidates,
      totalQueries: queryTexts.length,
      uniqueTerms: candidates.length,
    };
  }

  /**
   * Fetch raw query texts from ClickHouse for the given tenant and index.
   */
  private async fetchQueryTexts(
    tenantId: string,
    indexId: string,
    lookbackDays: number,
  ): Promise<string[]> {
    const query = `
      SELECT query_text
      FROM abl_platform.search_queries
      WHERE tenant_id = {tenantId:String}
        AND index_id = {indexId:String}
        AND timestamp >= now() - INTERVAL {lookbackDays:UInt32} DAY
        AND query_text != ''
      ORDER BY timestamp DESC
      LIMIT 10000
      SETTINGS max_execution_time = 30
    `;

    const result = await this.clickhouse.query({
      query,
      query_params: { tenantId, indexId, lookbackDays },
      format: 'JSONEachRow',
    });

    const rows = await result.json<RawQueryRow>();
    return rows.map((r) => r.query_text);
  }

  /**
   * Build co-occurrence map: for each qualified term, count how often
   * it appears in the same query as other qualified terms.
   */
  private buildCoOccurrenceMap(
    tokenizedQueries: string[][],
    qualifiedTerms: Set<string>,
  ): Map<string, Array<{ term: string; count: number }>> {
    const coOccurrence = new Map<string, Map<string, number>>();

    for (const tokens of tokenizedQueries) {
      const qualifiedInQuery = [...new Set(tokens)].filter((t) => qualifiedTerms.has(t));

      for (let i = 0; i < qualifiedInQuery.length; i++) {
        for (let j = i + 1; j < qualifiedInQuery.length; j++) {
          const a = qualifiedInQuery[i];
          const b = qualifiedInQuery[j];

          // Bidirectional
          if (!coOccurrence.has(a)) coOccurrence.set(a, new Map());
          if (!coOccurrence.has(b)) coOccurrence.set(b, new Map());
          coOccurrence.get(a)!.set(b, (coOccurrence.get(a)!.get(b) ?? 0) + 1);
          coOccurrence.get(b)!.set(a, (coOccurrence.get(b)!.get(a) ?? 0) + 1);
        }
      }
    }

    // Convert to array format
    const result = new Map<string, Array<{ term: string; count: number }>>();
    for (const [term, peers] of coOccurrence) {
      result.set(
        term,
        [...peers.entries()].map(([peerTerm, count]) => ({ term: peerTerm, count })),
      );
    }
    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Tokenize a query string into lowercase terms.
 * Splits on whitespace and punctuation, preserves hyphenated words.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
