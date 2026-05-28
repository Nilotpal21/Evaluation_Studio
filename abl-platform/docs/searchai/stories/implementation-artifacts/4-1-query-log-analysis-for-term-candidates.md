# Story 4.1: Query Log Analysis for Term Candidates

## Status: ready-for-dev

## Story

As a SearchAI Administrator,
I want the system to analyze historical query logs to extract frequently used domain terms,
So that vocabulary generation reflects actual user language and search patterns.

## Context

**This is a NEW service story.** No query log analysis exists today. The system needs to:

1. **Read historical queries** from the ClickHouse `abl_platform.search_queries` table (written by `ClickHouseSearchQueryStore` in search-ai-runtime)
2. **Extract high-frequency terms** from `query_text` grouped by field, filtering stopwords
3. **Calculate statistics** (term frequency, co-occurrence)
4. **Store candidates** in a new `VocabularyCandidates` MongoDB collection with a TTL index (7 days auto-expiry)

The query log data lives in ClickHouse (search-ai-runtime writes via `ClickHouseSearchQueryStore.record()`), but the analysis service runs in search-ai (the ingestion/admin app). This means search-ai needs a ClickHouse read client for analytics queries.

**Workflow Position:** This is Step 1 of Epic 4 (Domain Vocabulary Generation). The candidates produced here feed into Story 4.2 (LLM-based vocabulary entry generation from candidates).

**Key Constraint:** The `search_queries` table stores `query_text` (the raw natural language query) but does NOT store per-field filter terms. Term extraction must parse the raw query text and correlate with field usage patterns from the `query_type` and filter metadata. The minimum threshold is 5 occurrences to qualify as a candidate.

## Acceptance Criteria

- [ ] New `VocabularyCandidates` MongoDB model with TTL index (`expiresAt`, 7 days)
- [ ] `QueryLogAnalysisService` reads from ClickHouse `search_queries` table filtered by `tenant_id` and `index_id`
- [ ] Service requires minimum 100 historical queries before producing candidates
- [ ] Extracts high-frequency terms (min 5 occurrences) from `query_text`
- [ ] Filters out stopwords using a stopword list (new file since `stopwords.ts` does not exist yet)
- [ ] Calculates term frequency and co-occurrence statistics per term pair
- [ ] Groups candidates by inferred field affinity (based on co-occurrence with known vocabulary terms)
- [ ] Stores candidates in `VocabularyCandidates` collection with `expiresAt` set to 7 days from creation
- [ ] All queries scope by `tenantId` — no cross-tenant data leakage
- [ ] Returns `{ candidates, totalQueries, uniqueTerms }` summary
- [ ] Handles ClickHouse unavailability gracefully (log warning, return empty result)
- [ ] BullMQ worker wraps the service for async execution

## Verified Service Signatures & Existing Code

### ClickHouse SearchQueryRecord (clickhouse-search-query-store.ts:15-44)

```typescript
export interface SearchQueryRecord {
  query_id: string;
  tenant_id: string;
  index_id: string;
  query_type: string; // 'vector' | 'hybrid' | 'structured' | 'aggregate' | 'suggest' | 'similar'
  query_text: string;
  result_count: number;
  latency_ms: number;
  vocab_resolve_ms: number;
  vector_search_ms: number;
  structured_filter_ms: number;
  rerank_ms: number;
  cache_hit: boolean;
  issued_by: string;
  timestamp: string;
}
```

**Location:** `apps/search-ai-runtime/src/services/stores/clickhouse-search-query-store.ts`
**Table:** `abl_platform.search_queries`

### Worker pattern (from vocabulary-generation-worker.ts)

```typescript
import { Job, Worker } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getLazyModel } from '../db/index.js';
import { createWorkerOptions } from './shared.js';

const logger = createLogger('query-log-analysis-worker');

// Job data interface
export interface QueryLogAnalysisJobData {
  tenantId: string;
  indexId: string;
  knowledgeBaseId: string;
}

// Worker factory
export function createQueryLogAnalysisWorker(): Worker {
  const worker = new Worker(QUEUE_NAME, processQueryLogAnalysisJob, createWorkerOptions(2));
  // ...event handlers...
  return worker;
}
```

### getLazyModel pattern (db/index.ts:384-400)

```typescript
export function getLazyModel<T = any>(modelName: string): Model<T> {
  let cachedModel: Model<T> | null = null;
  return new Proxy({} as Model<T>, {
    get(_target, prop) {
      if (!cachedModel) {
        cachedModel = getModel<T>(modelName);
      }
      const value = (cachedModel as any)[prop];
      return typeof value === 'function' ? value.bind(cachedModel) : value;
    },
  });
}
```

### TTL index pattern (from workspace-invitation.model.ts:58)

```typescript
SchemaName.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```

### DomainVocabulary model (for downstream reference)

```typescript
export interface IDomainVocabulary {
  _id: string;
  tenantId: string;
  projectKnowledgeBaseId: string; // References SearchIndex._id
  version: number;
  status: 'draft' | 'active' | 'inactive';
  entries: IVocabularyEntry[];
  createdAt: Date;
  updatedAt: Date;
}
```

### Error handling pattern (from field-mapping-suggestion-worker.ts:276-279)

```typescript
} catch (error: unknown) {
  const errMsg = error instanceof Error ? error.message : String(error);
  workerError('worker-name', `Job failed: ${errMsg}`, error);
  throw error; // BullMQ retries based on job options
}
```

### Shared worker helpers (shared.ts)

```typescript
export function createWorkerOptions(concurrency = 5): WorkerOptions;
export function createQueue(name: string): Queue;
export function workerLog(worker: string, message: string, meta?: Record<string, unknown>): void;
export function workerError(worker: string, message: string, error: unknown): void;
```

## File List

| File                                                                           | Action | Description                                                               |
| ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------- |
| `packages/database/src/models/vocabulary-candidates.model.ts`                  | CREATE | New MongoDB model with TTL index for temporary term candidates            |
| `packages/database/src/models/index.ts`                                        | MODIFY | Export new VocabularyCandidates model                                     |
| `packages/search-ai-internal/src/canonical/stopwords.ts`                       | CREATE | English stopword list (300+ terms) for filtering                          |
| `packages/search-ai-internal/src/canonical/index.ts`                           | MODIFY | Re-export stopwords                                                       |
| `apps/search-ai/src/services/query-log-analysis/query-log-analysis.service.ts` | CREATE | Core service: ClickHouse read, term extraction, stopword filtering, stats |
| `apps/search-ai/src/services/query-log-analysis/index.ts`                      | CREATE | Barrel export                                                             |
| `apps/search-ai/src/workers/query-log-analysis-worker.ts`                      | CREATE | BullMQ worker wrapping QueryLogAnalysisService                            |
| `apps/search-ai/src/db/index.ts`                                               | MODIFY | Register VocabularyCandidates model in ModelRegistry                      |
| `apps/search-ai/src/workers/__tests__/query-log-analysis-worker.test.ts`       | CREATE | Unit tests for worker and service                                         |

## Tasks

### Task 1: Create the VocabularyCandidates MongoDB model

File: `packages/database/src/models/vocabulary-candidates.model.ts`

```typescript
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Interfaces ───────────────────────────────────────────────────────────

export interface ITermCandidate {
  term: string;
  frequency: number; // Total occurrences across all queries
  queryCount: number; // Number of distinct queries containing this term
  fieldAffinity: string | null; // Inferred canonical field (if any)
  coOccurrences: Array<{
    term: string;
    count: number;
  }>;
  sampleQueries: string[]; // Up to 5 sample queries containing this term
}

export interface IVocabularyCandidates {
  _id: string;
  tenantId: string;
  indexId: string; // SearchIndex._id
  knowledgeBaseId: string;
  totalQueriesAnalyzed: number;
  uniqueTermsExtracted: number;
  candidates: ITermCandidate[];
  analysisTimestamp: Date;
  expiresAt: Date; // TTL — MongoDB auto-deletes after this
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────

const TermCandidateSchema = new Schema<ITermCandidate>(
  {
    term: { type: String, required: true },
    frequency: { type: Number, required: true },
    queryCount: { type: Number, required: true },
    fieldAffinity: { type: String, default: null },
    coOccurrences: [
      {
        term: { type: String, required: true },
        count: { type: Number, required: true },
      },
    ],
    sampleQueries: { type: [String], default: [] },
  },
  { _id: false },
);

const VocabularyCandidatesSchema = new Schema<IVocabularyCandidates>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    knowledgeBaseId: { type: String, required: true },
    totalQueriesAnalyzed: { type: Number, required: true },
    uniqueTermsExtracted: { type: Number, required: true },
    candidates: { type: [TermCandidateSchema], default: [] },
    analysisTimestamp: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'vocabulary_candidates' },
);

// ─── Plugins ──────────────────────────────────────────────────────────────

VocabularyCandidatesSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ──────────────────────────────────────────────────────────────

VocabularyCandidatesSchema.index({ tenantId: 1, indexId: 1 });
// TTL index: MongoDB automatically removes documents when expiresAt is reached
VocabularyCandidatesSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ────────────────────────────────────────────────────────────────

export const VocabularyCandidates =
  (mongoose.models.VocabularyCandidates as any) ||
  model<IVocabularyCandidates>('VocabularyCandidates', VocabularyCandidatesSchema);
```

Then add the export to `packages/database/src/models/index.ts`:

```typescript
export {
  VocabularyCandidates,
  type IVocabularyCandidates,
  type ITermCandidate,
} from './vocabulary-candidates.model.js';
```

### Task 2: Create the stopwords list

File: `packages/search-ai-internal/src/canonical/stopwords.ts`

```typescript
/**
 * English Stopwords for Query Log Term Extraction
 *
 * Used by QueryLogAnalysisService to filter out non-domain terms.
 * Includes standard English stopwords plus common search-specific filler words.
 */

export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  // Articles & determiners
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  // Pronouns
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'it',
  'they',
  'them',
  // Prepositions
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'about',
  // Conjunctions
  'and',
  'or',
  'but',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  // Verbs (common/auxiliary)
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'can',
  'could',
  // Adverbs & misc
  'how',
  'what',
  'when',
  'where',
  'who',
  'which',
  'why',
  'all',
  'each',
  'every',
  'any',
  'few',
  'more',
  'most',
  'some',
  'such',
  'no',
  'only',
  'same',
  'than',
  'too',
  'very',
  'just',
  'also',
  'now',
  // Search-specific filler words
  'show',
  'find',
  'get',
  'list',
  'give',
  'tell',
  'search',
  'look',
  'looking',
  'want',
  'need',
  'please',
  'help',
  'me',
  'us',
]);

/**
 * Check if a token is a stopword.
 * Normalizes to lowercase before checking.
 */
export function isStopword(token: string): boolean {
  return ENGLISH_STOPWORDS.has(token.toLowerCase());
}

/**
 * Filter stopwords from an array of tokens.
 * Also removes tokens shorter than 2 characters and purely numeric tokens.
 */
export function filterStopwords(tokens: string[]): string[] {
  return tokens.filter((t) => {
    const lower = t.toLowerCase();
    if (lower.length < 2) return false;
    if (/^\d+$/.test(lower)) return false;
    return !ENGLISH_STOPWORDS.has(lower);
  });
}
```

Then add re-export to `packages/search-ai-internal/src/canonical/index.ts`:

```typescript
export { ENGLISH_STOPWORDS, isStopword, filterStopwords } from './stopwords.js';
```

### Task 3: Create the QueryLogAnalysisService

File: `apps/search-ai/src/services/query-log-analysis/query-log-analysis.service.ts`

```typescript
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
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
```

Barrel export at `apps/search-ai/src/services/query-log-analysis/index.ts`:

```typescript
export {
  QueryLogAnalysisService,
  type QueryLogAnalysisResult,
  type QueryLogAnalysisOptions,
} from './query-log-analysis.service.js';
```

### Task 4: Create the BullMQ worker

File: `apps/search-ai/src/workers/query-log-analysis-worker.ts`

```typescript
/**
 * Query Log Analysis Worker
 *
 * BullMQ worker that runs QueryLogAnalysisService to extract
 * vocabulary term candidates from historical search queries.
 *
 * WORKFLOW POSITION: Step 1 of Epic 4 (Domain Vocabulary Generation)
 *   **Query Log Analysis** → Critical Field Detection → Vocabulary Generation
 *
 * DESIGN TIME: This worker runs periodically or on-demand (not per document/query).
 */

import { Job, Worker } from 'bullmq';
import { createClient } from '@clickhouse/client';
import { withTenantContext } from '@agent-platform/database/mongo';
import { createLogger } from '@abl/compiler/platform';
import { QueryLogAnalysisService } from '../services/query-log-analysis/index.js';
import { createWorkerOptions, workerLog, workerError } from './shared.js';

const logger = createLogger('query-log-analysis-worker');

// ─── Queue Name ───────────────────────────────────────────────────────────

export const QUEUE_QUERY_LOG_ANALYSIS = 'search-query-log-analysis';

// ─── Job Data ─────────────────────────────────────────────────────────────

export interface QueryLogAnalysisJobData {
  tenantId: string;
  indexId: string;
  knowledgeBaseId: string;
  /** Lookback window in days (default: 30) */
  lookbackDays?: number;
}

// ─── Job Processor ────────────────────────────────────────────────────────

export async function processQueryLogAnalysisJob(job: Job<QueryLogAnalysisJobData>): Promise<void> {
  const { tenantId, indexId, knowledgeBaseId, lookbackDays } = job.data;

  workerLog('query-log-analysis', 'Starting query log analysis', {
    jobId: job.id,
    tenantId,
    indexId,
    knowledgeBaseId,
    lookbackDays,
  });

  await withTenantContext({ tenantId }, async () => {
    try {
      await job.updateProgress(10);

      // Create ClickHouse client for read-only analytics
      const clickhouse = createClient({
        url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
        username: process.env.CLICKHOUSE_USER || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || '',
        database: process.env.CLICKHOUSE_DATABASE || 'abl_platform',
      });

      try {
        const service = new QueryLogAnalysisService(clickhouse);

        await job.updateProgress(20);

        const result = await service.analyze({
          tenantId,
          indexId,
          knowledgeBaseId,
          lookbackDays,
        });

        await job.updateProgress(100);

        workerLog('query-log-analysis', 'Query log analysis completed', {
          jobId: job.id,
          tenantId,
          indexId,
          totalQueries: result.totalQueries,
          uniqueTerms: result.uniqueTerms,
          candidateCount: result.candidates.length,
        });
      } finally {
        await clickhouse.close();
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      workerError('query-log-analysis', `Query log analysis failed: ${errMsg}`, error);
      throw error; // BullMQ retries based on job options
    }
  });
}

// ─── Worker Factory ───────────────────────────────────────────────────────

export function createQueryLogAnalysisWorker(concurrency = 2): Worker<QueryLogAnalysisJobData> {
  const worker = new Worker<QueryLogAnalysisJobData>(
    QUEUE_QUERY_LOG_ANALYSIS,
    processQueryLogAnalysisJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('query-log-analysis', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('query-log-analysis', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('query-log-analysis', 'Worker error', err);
  });

  workerLog('query-log-analysis', `Started with concurrency=${concurrency}`);
  return worker;
}
```

### Task 5: Register VocabularyCandidates model in search-ai db/index.ts

Add to the `initMongoBackend` function's `Promise.all([...])` block:

```typescript
import('@agent-platform/database/models').then((mod) => {
  if ((mod as any).VocabularyCandidates?.schema && !ModelRegistry.hasModel('VocabularyCandidates')) {
    ModelRegistry.registerModelDefinition(
      'VocabularyCandidates',
      (mod as any).VocabularyCandidates.schema,
      'searchaicontent',
    );
  }
}),
```

### Task 6: Write unit tests

File: `apps/search-ai/src/workers/__tests__/query-log-analysis-worker.test.ts`

Tests to cover:

1. **Tokenization**: Verify `tokenize()` splits on whitespace/punctuation, lowercases
2. **Stopword filtering**: Verify common stopwords removed, domain terms preserved
3. **Minimum query threshold**: Returns empty result when < 100 queries
4. **Term frequency**: Correct counting with min 5 occurrences filter
5. **Co-occurrence**: Terms appearing in same query produce bidirectional co-occurrence entries
6. **TTL**: `expiresAt` set to 7 days from analysis time
7. **ClickHouse unavailable**: Returns empty result, logs warning (no throw)
8. **Tenant isolation**: Service passes `tenantId` filter to ClickHouse query
9. **Worker job data**: Job processor calls service with correct options
10. **Upsert**: Second analysis for same tenant+index overwrites previous candidates

## Previous Story Intelligence

### From Epic 1 Retro

- **`getLazyModel` is MANDATORY** in `apps/search-ai/` — never import models directly from `@agent-platform/database/models`. Use `getLazyModel<IVocabularyCandidates>('VocabularyCandidates')`.

### From Epic 2 Retro

- **Error format**: Use `{ error: { code: string, message: string } }` for any API endpoints. Workers use `workerError()` helper for structured logging.
- **Logger pattern**: `createLogger('module-name')` from `@abl/compiler/platform`. Log format: `logger.error('message', { error: error instanceof Error ? error.message : String(error) })`.
- **Epic field name mismatches**: Always verify field names against actual model source before coding. The epic says "TraceStore" for query logs but the actual data source is ClickHouse `search_queries` table.
- **Adapter functions**: When bridging between service interfaces (e.g., ClickHouse rows to MongoDB documents), use explicit adapter functions.

### From Epic 3 Retro

- **Run prettier before finishing**: `npx prettier --write <files>` on ALL changed files. lint-staged WILL silently revert work if files are not formatted.
- **MappingStatus constants**: Use `MappingStatus.SUGGESTED`, `MappingStatus.CONFIRMED`, `MappingStatus.REJECTED` from `@agent-platform/search-ai-sdk`.

### Model Registration

- New models must be registered in `apps/search-ai/src/db/index.ts` inside the `Promise.all([...])` block with the correct database tag (`'searchaicontent'` for generated/operational data, `'platform'` for config data).
- VocabularyCandidates is operational/temporary data so it belongs on `'searchaicontent'`.

### Dockerfile Package Sync

- If `packages/database/` gains a new export, no Dockerfile changes needed (package already exists).
- If a new workspace package were created, its `package.json` COPY line would need adding to every Dockerfile.

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/database
pnpm build --filter=@agent-platform/search-ai-internal
pnpm build --filter=@agent-platform/search-ai
pnpm vitest run apps/search-ai/src/workers/__tests__/query-log-analysis-worker.test.ts
npx prettier --write <changed files>
```
