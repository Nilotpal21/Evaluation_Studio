# Story 4.2: Document Content Sampling for Enum Discovery

## Status: ready-for-dev

## Story

As a SearchAI Administrator,
I want the system to sample ingested documents from OpenSearch to discover enum-like field values,
So that vocabulary includes common statuses, priorities, and categories from actual data.

## Context

**This is a NEW service.** No document content sampling or enum discovery service exists yet. The service will:

1. Query OpenSearch using `random_score` function for stratified sampling (max 10,000 docs)
2. Run `terms` aggregations on mapped canonical fields that have `enumValues` defined in CanonicalSchema
3. Filter results by cardinality (at most 50 distinct values) and frequency (exclude values below 0.1%)
4. Return enum candidates with confidence scores based on distribution uniformity

The service uses the existing `VectorStoreProvider.executeQuery()` method on `OpenSearchVectorStore` to send arbitrary DSL queries with aggregations. The index name is resolved via `getAppIndices()` from `@agent-platform/search-ai-internal`.

Canonical fields live under `metadata.canonical.*` in OpenSearch (e.g., `metadata.canonical.status`, `metadata.canonical.category`). Only `keyword`-typed fields are valid enum candidates -- `text`, `float`, `date`, and `boolean` fields are excluded.

## Acceptance Criteria

- [ ] `DocumentContentSampler` service class created in `apps/search-ai/src/services/vocabulary/`
- [ ] `sampleEnumValues()` method queries OpenSearch with `function_score` + `random_score` for unbiased sampling
- [ ] Sampling is capped at 10,000 documents via `size: 0` + `terms` aggregation (no doc bodies fetched)
- [ ] Only fields with `enumValues` defined in CanonicalSchema AND `type: 'keyword'` in the OpenSearch mapping are sampled
- [ ] Fields with cardinality > 50 are excluded from results (not enum-like)
- [ ] Values with frequency < 0.1% of total sampled docs are excluded (noise)
- [ ] Each candidate includes: `storageField`, `alias`, `values: Array<{ value, count, frequency }>`, `cardinality`, `confidence`
- [ ] Confidence score is calculated from distribution uniformity (low entropy = high confidence)
- [ ] Service enforces tenant isolation: only queries indices belonging to the tenant's app
- [ ] Service returns `{ candidates: EnumCandidate[], sampledDocCount: number, indexName: string }` response shape
- [ ] All errors logged with `createLogger('document-content-sampler')`, never `console.log`
- [ ] Consistent error format: `{ error: { code: string, message: string } }` on failures

## Verified Service Signatures & Existing Code

### VectorStoreProvider.executeQuery() (opensearch.ts:538-563)

```typescript
async executeQuery(
  collection: string,
  body: Record<string, unknown>,
): Promise<{
  hits: Array<{ id: string; score: number; source: Record<string, unknown> }>;
  aggregations?: Record<string, unknown>;
  total: number;
}> {
  const response = await this.client.search({
    index: collection,
    body,
  });
  // ... maps response.body.hits.hits and response.body.aggregations
}
```

### createVectorStore factory (factory.ts:22-51)

```typescript
import { createVectorStore, type VectorStoreProvider } from '@agent-platform/search-ai-internal';

const vectorStore: VectorStoreProvider = createVectorStore({
  provider: (process.env.VECTOR_STORE_PROVIDER as 'opensearch' | 'qdrant') || 'opensearch',
  url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
  apiKey: process.env.VECTOR_STORE_API_KEY,
});
```

### getAppIndices (index-registry.ts:441-455)

```typescript
import { getAppIndices } from '@agent-platform/search-ai-internal';

// Returns unique index names for a tenant+app
const indices: string[] = await getAppIndices(tenantId, appId);
```

### CanonicalSchema model with ICanonicalField (canonical-schema.model.ts)

```typescript
export interface ICanonicalField {
  name: string; // alias (business-friendly)
  label: string; // display label
  type: string; // 'string' | 'number' | 'float' | 'date' | 'boolean' | 'text' | 'array'
  description?: string;
  storageField: string; // actual field in OpenSearch (e.g., "status", "custom_string_1")
  indexed: boolean;
  filterable: boolean;
  aggregatable: boolean;
  sortable: boolean;
  enumValues?: Record<string, unknown>;
  sourceConnectorField?: string;
}
```

### getLazyModel pattern (db/index.ts)

```typescript
import { getLazyModel } from '../db/index.js';
import type { ICanonicalSchema, ISearchIndex } from '@agent-platform/database/models';

const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
```

### Auth + tenant isolation pattern (documents.ts)

```typescript
const tenantId = req.tenantContext!.tenantId;
const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
if (!index) {
  res.status(404).json({ error: 'Index not found' });
  return;
}
```

### OpenSearch canonical field paths (opensearch-mappings.ts:207-310)

Canonical fields live under `metadata.canonical.*` in the index. Keyword-typed enum candidates:

- Core: `metadata.canonical.status`, `metadata.canonical.category`, `metadata.canonical.access_level`, `metadata.canonical.language`, `metadata.canonical.source_type`
- Common: `metadata.canonical.priority` (float -- excluded), `metadata.canonical.severity`, `metadata.canonical.resolution`, `metadata.canonical.stage`, `metadata.canonical.department`, `metadata.canonical.sprint`, `metadata.canonical.epic`, `metadata.canonical.environment`
- Custom: `metadata.canonical.custom_string_1` through `metadata.canonical.custom_string_20`

Only `keyword`-typed fields support `terms` aggregation. `text` and `float` fields must be excluded.

### MAPPING_STATUS constants (apps/studio/src/api/search-ai.ts:126-133)

```typescript
export const MAPPING_STATUS = {
  CONFIRMED: 'active',
  SUGGESTED: 'suggested',
  REJECTED: 'rejected',
} as const;
```

Backend uses raw string values (`'active'`, `'suggested'`).

## File List

| File                                                                                | Action | Description                                                                          |
| ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `apps/search-ai/src/services/vocabulary/document-content-sampler.ts`                | CREATE | Core sampling service with `sampleEnumValues()` method                               |
| `apps/search-ai/src/services/vocabulary/types.ts`                                   | CREATE | Shared types: `EnumCandidate`, `EnumValueEntry`, `SamplingResult`, `SamplingOptions` |
| `apps/search-ai/src/services/vocabulary/index.ts`                                   | CREATE | Barrel export for vocabulary services                                                |
| `apps/search-ai/src/services/vocabulary/__tests__/document-content-sampler.test.ts` | CREATE | Unit tests with mocked OpenSearch and MongoDB                                        |

## Tasks

### Task 1: Define types in `types.ts`

Create the shared type definitions for the vocabulary sampling subsystem.

```typescript
// apps/search-ai/src/services/vocabulary/types.ts

/** A single distinct value discovered in a field */
export interface EnumValueEntry {
  /** The actual value found in documents */
  value: string;
  /** Number of documents containing this value */
  count: number;
  /** Frequency as fraction of sampled documents (0-1) */
  frequency: number;
}

/** An enum candidate discovered from document sampling */
export interface EnumCandidate {
  /** Storage field name in OpenSearch (e.g., "status", "custom_string_1") */
  storageField: string;
  /** Alias name from CanonicalSchema (e.g., "ticket_status") */
  alias: string | null;
  /** Display label (e.g., "Ticket Status") */
  label: string | null;
  /** Distinct values discovered, sorted by count descending */
  values: EnumValueEntry[];
  /** Number of distinct values */
  cardinality: number;
  /** Confidence score (0-1) based on distribution uniformity */
  confidence: number;
}

/** Result of a document content sampling run */
export interface SamplingResult {
  /** Enum candidates discovered */
  candidates: EnumCandidate[];
  /** Number of documents in the sampled index */
  sampledDocCount: number;
  /** OpenSearch index that was sampled */
  indexName: string;
}

/** Options for controlling sampling behavior */
export interface SamplingOptions {
  /** Maximum documents to consider (default: 10000) */
  maxSampleSize?: number;
  /** Maximum distinct values per field before excluding (default: 50) */
  maxCardinality?: number;
  /** Minimum frequency threshold as fraction (default: 0.001 = 0.1%) */
  minFrequency?: number;
}
```

### Task 2: Create the `DocumentContentSampler` service

```typescript
// apps/search-ai/src/services/vocabulary/document-content-sampler.ts

import {
  createVectorStore,
  getAppIndices,
  type VectorStoreProvider,
} from '@agent-platform/search-ai-internal';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../../db/index.js';
import type { ICanonicalSchema, ISearchIndex } from '@agent-platform/database/models';
import type { EnumCandidate, EnumValueEntry, SamplingOptions, SamplingResult } from './types.js';

const logger = createLogger('document-content-sampler');

const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

/** OpenSearch field types that support terms aggregation */
const KEYWORD_FIELD_TYPES = new Set(['keyword']);

/** Default sampling constants */
const DEFAULT_MAX_SAMPLE_SIZE = 10_000;
const DEFAULT_MAX_CARDINALITY = 50;
const DEFAULT_MIN_FREQUENCY = 0.001; // 0.1%

export class DocumentContentSampler {
  private vectorStore: VectorStoreProvider;

  constructor(vectorStore?: VectorStoreProvider) {
    this.vectorStore =
      vectorStore ??
      createVectorStore({
        provider:
          (process.env.VECTOR_STORE_PROVIDER as
            | 'opensearch'
            | 'qdrant'
            | 'pinecone'
            | 'pgvector') || 'opensearch',
        url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
        apiKey: process.env.VECTOR_STORE_API_KEY,
      });
  }

  /**
   * Sample ingested documents from OpenSearch to discover enum-like field values.
   *
   * @param knowledgeBaseId - The SearchIndex._id (knowledge base identifier)
   * @param tenantId - Tenant identifier for isolation
   * @param options - Sampling configuration overrides
   */
  async sampleEnumValues(
    knowledgeBaseId: string,
    tenantId: string,
    options: SamplingOptions = {},
  ): Promise<SamplingResult> {
    const maxSampleSize = options.maxSampleSize ?? DEFAULT_MAX_SAMPLE_SIZE;
    const maxCardinality = options.maxCardinality ?? DEFAULT_MAX_CARDINALITY;
    const minFrequency = options.minFrequency ?? DEFAULT_MIN_FREQUENCY;

    // 1. Verify the SearchIndex belongs to this tenant
    const searchIndex = await SearchIndex.findOne({ _id: knowledgeBaseId, tenantId }).lean();
    if (!searchIndex) {
      logger.warn('SearchIndex not found or wrong tenant', { knowledgeBaseId, tenantId });
      return { candidates: [], sampledDocCount: 0, indexName: '' };
    }

    // 2. Load active CanonicalSchema to find enum-eligible fields
    const schema = await CanonicalSchema.findOne({
      knowledgeBaseId,
      tenantId,
      status: 'active',
    })
      .sort({ version: -1 })
      .lean();

    if (!schema || !schema.fields?.length) {
      logger.info('No active canonical schema found', { knowledgeBaseId });
      return { candidates: [], sampledDocCount: 0, indexName: '' };
    }

    // 3. Filter to keyword-typed fields that have enumValues defined
    const enumFields = schema.fields.filter(
      (f) => f.enumValues && Object.keys(f.enumValues).length > 0 && this.isKeywordField(f.type),
    );

    if (enumFields.length === 0) {
      logger.info('No enum-eligible fields found in schema', {
        knowledgeBaseId,
        totalFields: schema.fields.length,
      });
      return { candidates: [], sampledDocCount: 0, indexName: '' };
    }

    // 4. Resolve the OpenSearch index name
    const appId = knowledgeBaseId; // SearchIndex._id is the appId
    const indices = await getAppIndices(tenantId, appId);
    if (indices.length === 0) {
      logger.warn('No OpenSearch indices found for app', { tenantId, appId });
      return { candidates: [], sampledDocCount: 0, indexName: '' };
    }
    const indexName = indices[0]; // Use primary index

    // 5. Build aggregation query with random_score sampling
    const aggs = this.buildTermsAggregations(enumFields, maxCardinality);
    const queryBody = this.buildSamplingQuery(tenantId, aggs, maxSampleSize);

    logger.info('Sampling documents for enum discovery', {
      knowledgeBaseId,
      indexName,
      enumFieldCount: enumFields.length,
      maxSampleSize,
    });

    // 6. Execute the query
    let result;
    try {
      result = await this.vectorStore.executeQuery!(indexName, queryBody);
    } catch (error) {
      logger.error('OpenSearch sampling query failed', {
        error: error instanceof Error ? error.message : String(error),
        indexName,
        knowledgeBaseId,
      });
      return { candidates: [], sampledDocCount: 0, indexName };
    }

    const sampledDocCount = result.total;

    if (sampledDocCount === 0) {
      logger.info('No documents found in index', { indexName });
      return { candidates: [], sampledDocCount: 0, indexName };
    }

    // 7. Parse aggregation results into EnumCandidates
    const candidates = this.parseAggregations(
      result.aggregations ?? {},
      enumFields,
      sampledDocCount,
      maxCardinality,
      minFrequency,
    );

    logger.info('Enum discovery complete', {
      knowledgeBaseId,
      indexName,
      sampledDocCount,
      candidateCount: candidates.length,
    });

    return { candidates, sampledDocCount, indexName };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Build the OpenSearch query body with function_score + random_score
   * and terms aggregations. Uses size:0 to skip fetching doc bodies.
   */
  private buildSamplingQuery(
    tenantId: string,
    aggs: Record<string, unknown>,
    maxSampleSize: number,
  ): Record<string, unknown> {
    return {
      size: 0, // We only need aggregations, not document bodies
      query: {
        function_score: {
          query: {
            bool: {
              filter: [{ term: { 'metadata.canonical.tenant_id': tenantId } }],
            },
          },
          functions: [
            {
              random_score: {
                seed: Date.now(),
                field: '_seq_no',
              },
            },
          ],
          boost_mode: 'replace',
        },
      },
      aggs,
      // Track total hits accurately for frequency calculation
      track_total_hits: maxSampleSize,
    };
  }

  /**
   * Build terms aggregations for each enum-eligible field.
   * Uses size:50 to capture up to maxCardinality distinct values.
   */
  private buildTermsAggregations(
    fields: Array<{ storageField: string; name: string; label: string }>,
    maxCardinality: number,
  ): Record<string, unknown> {
    const aggs: Record<string, unknown> = {};

    for (const field of fields) {
      const fieldPath = `metadata.canonical.${field.storageField}`;
      aggs[`enum_${field.storageField}`] = {
        terms: {
          field: fieldPath,
          size: maxCardinality,
          min_doc_count: 1,
        },
      };
    }

    return aggs;
  }

  /**
   * Parse OpenSearch aggregation results into EnumCandidate objects.
   * Filters by cardinality and frequency thresholds.
   */
  private parseAggregations(
    aggregations: Record<string, unknown>,
    fields: Array<{ storageField: string; name: string; label: string }>,
    totalDocs: number,
    maxCardinality: number,
    minFrequency: number,
  ): EnumCandidate[] {
    const candidates: EnumCandidate[] = [];

    for (const field of fields) {
      const aggKey = `enum_${field.storageField}`;
      const aggResult = aggregations[aggKey] as
        | { buckets?: Array<{ key: string; doc_count: number }> }
        | undefined;

      if (!aggResult?.buckets || aggResult.buckets.length === 0) {
        continue;
      }

      const buckets = aggResult.buckets;

      // Skip fields with too many distinct values (not enum-like)
      if (buckets.length >= maxCardinality) {
        logger.debug('Field excluded: cardinality too high', {
          storageField: field.storageField,
          cardinality: buckets.length,
          maxCardinality,
        });
        continue;
      }

      // Filter values by minimum frequency
      const minCount = Math.max(1, Math.floor(totalDocs * minFrequency));
      const filteredValues: EnumValueEntry[] = buckets
        .filter((b) => b.doc_count >= minCount)
        .map((b) => ({
          value: String(b.key),
          count: b.doc_count,
          frequency: totalDocs > 0 ? b.doc_count / totalDocs : 0,
        }));

      if (filteredValues.length === 0) {
        continue;
      }

      // Calculate confidence from distribution uniformity
      const confidence = this.calculateConfidence(filteredValues, totalDocs);

      candidates.push({
        storageField: field.storageField,
        alias: field.name ?? null,
        label: field.label ?? null,
        values: filteredValues,
        cardinality: filteredValues.length,
        confidence,
      });
    }

    // Sort candidates by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    return candidates;
  }

  /**
   * Calculate confidence score for an enum candidate based on distribution.
   *
   * High confidence = values have relatively uniform distribution (true enum).
   * Low confidence = one value dominates (may be a default, not a real enum).
   *
   * Uses normalized Shannon entropy: H / log2(n).
   * - 1.0 = perfectly uniform distribution (highest confidence)
   * - 0.0 = single value dominates (lowest confidence)
   */
  private calculateConfidence(values: EnumValueEntry[], totalDocs: number): number {
    if (values.length <= 1) return 0.5; // Single value is ambiguous

    const total = values.reduce((sum, v) => sum + v.count, 0);
    if (total === 0) return 0;

    // Shannon entropy
    let entropy = 0;
    for (const v of values) {
      const p = v.count / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    // Normalize by max possible entropy (uniform distribution)
    const maxEntropy = Math.log2(values.length);
    const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

    // Coverage factor: what fraction of docs have this field populated
    const coverage = total / totalDocs;
    const coverageFactor = Math.min(1, coverage * 2); // Full credit at 50%+ coverage

    // Final confidence: weighted combination
    return (Math.round(normalizedEntropy * 0.7 + coverageFactor * 0.3) * 100) / 100 || 0;
  }

  /**
   * Check if a canonical field type maps to a keyword-typed OpenSearch field.
   * Only keyword fields support terms aggregation.
   */
  private isKeywordField(fieldType: string): boolean {
    // CanonicalField.type values that map to keyword in OpenSearch
    // See opensearch-mappings.ts for the full mapping
    return fieldType === 'string' || fieldType === 'keyword';
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: DocumentContentSampler | null = null;

export function getDocumentContentSampler(): DocumentContentSampler {
  if (!instance) {
    instance = new DocumentContentSampler();
  }
  return instance;
}
```

**Key design decisions:**

- `size: 0` in the query body means we never fetch document bodies, only aggregations. This is far more efficient than sampling 10,000 docs.
- `random_score` with `boost_mode: 'replace'` ensures unbiased sampling when combined with `track_total_hits`.
- `terms` aggregation `size: 50` caps at `maxCardinality` to avoid pulling high-cardinality fields.
- Confidence uses Shannon entropy (normalized) plus a coverage factor.

### Task 3: Create barrel export in `index.ts`

```typescript
// apps/search-ai/src/services/vocabulary/index.ts

export { DocumentContentSampler, getDocumentContentSampler } from './document-content-sampler.js';
export type { EnumCandidate, EnumValueEntry, SamplingResult, SamplingOptions } from './types.js';
```

### Task 4: Write unit tests

Create `apps/search-ai/src/services/vocabulary/__tests__/document-content-sampler.test.ts`:

Tests to implement:

1. **Returns candidates for valid enum fields** -- Mock `executeQuery` to return aggregation buckets, verify candidate shape, cardinality, and frequency calculations.
2. **Excludes fields with cardinality > 50** -- Return 50+ buckets for a field, verify it is excluded from results.
3. **Excludes values below 0.1% frequency** -- Return a bucket with doc_count=1 out of 10,000 total, verify it is filtered out.
4. **Returns empty when no active schema exists** -- Mock `CanonicalSchema.findOne` to return null.
5. **Returns empty when no enum fields in schema** -- Schema with fields but none have `enumValues`.
6. **Tenant isolation: returns empty for wrong tenant** -- Mock `SearchIndex.findOne` to return null for wrong tenantId.
7. **Confidence calculation: uniform distribution gives high score** -- Pass in equal counts.
8. **Confidence calculation: single-dominant value gives low score** -- Pass in one value with 99% of docs.
9. **Handles OpenSearch query failure gracefully** -- Mock `executeQuery` to throw, verify empty result and error logging.
10. **Excludes non-keyword field types** -- Add a `float`-typed field with enumValues, verify it is not aggregated.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentContentSampler } from '../document-content-sampler.js';

// Mock getLazyModel
vi.mock('../../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    // Return mock models -- tests will override .findOne
    return {
      findOne: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
        lean: vi.fn().mockResolvedValue(null),
      }),
    };
  }),
}));

// Mock getAppIndices
vi.mock('@agent-platform/search-ai-internal', () => ({
  createVectorStore: vi.fn(),
  getAppIndices: vi.fn().mockResolvedValue(['search-vectors-v1']),
}));

describe('DocumentContentSampler', () => {
  let sampler: DocumentContentSampler;
  let mockVectorStore: { executeQuery: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockVectorStore = {
      executeQuery: vi.fn().mockResolvedValue({
        hits: [],
        aggregations: {},
        total: 0,
      }),
    };
    sampler = new DocumentContentSampler(mockVectorStore as any);
  });

  it('returns empty candidates when no schema exists', async () => {
    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toEqual([]);
  });

  // Additional tests per list above...
});
```

### Task 5: Verify build compiles

```bash
pnpm build --filter=@agent-platform/search-ai
npx prettier --write apps/search-ai/src/services/vocabulary/**/*.ts
```

## Previous Story Intelligence

- **`getLazyModel` is MANDATORY** in `apps/search-ai/` -- never import models directly from `@agent-platform/database/models` (Epic 1 retro). The dual-database layer binds models to the correct connection at runtime.
- **Error format**: Use `{ error: { code: string, message: string } }` for structured errors. Older endpoints use `{ error: 'string' }` but new code should use the structured format.
- **Logger pattern**: `createLogger('module')` from `@abl/compiler/platform`. Error logging: `logger.error('message', { error: error instanceof Error ? error.message : String(error) })`. Never `console.log` in server code.
- **MAPPING_STATUS constants**: Backend stores `'active'` (confirmed), `'suggested'` (pending), `'rejected'`. These are raw strings in MongoDB, not constants on the backend.
- **Run prettier before finishing**: `npx prettier --write <files>` on all changed files. The pre-commit hook runs `prettier --check` and lint-staged will silently revert un-formatted edits.
- **`executeQuery` is optional on VectorStoreProvider** -- it exists on `OpenSearchVectorStore` but is marked optional on the interface. Guard with `if (!this.vectorStore.executeQuery)` or assert at construction time.
- **Canonical field paths**: Fields are stored under `metadata.canonical.*` in OpenSearch, not at the root level. The `storageField` from `ICanonicalField` is the leaf name (e.g., `status`), so the full path is `metadata.canonical.${storageField}`.
- **Index resolution**: Use `getAppIndices(tenantId, appId)` from `@agent-platform/search-ai-internal` to get the correct OpenSearch index names. Do not hardcode index names.

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/search-ai
pnpm vitest run apps/search-ai/src/services/vocabulary/__tests__/document-content-sampler.test.ts
npx prettier --write apps/search-ai/src/services/vocabulary/**/*.ts
```
