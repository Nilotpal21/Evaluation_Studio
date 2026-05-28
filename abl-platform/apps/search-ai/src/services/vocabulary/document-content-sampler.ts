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

    // 3. Filter to keyword-typed fields eligible for enum discovery.
    //    On initial discovery, fields may not yet have enumValues — sample ALL keyword fields
    //    so we can discover enum-like value distributions from ingested documents.
    const enumFields = schema.fields.filter((f) => this.isKeywordField(f.type));

    if (enumFields.length === 0) {
      logger.info('No keyword fields found in schema for enum discovery', {
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
    if (!this.vectorStore.executeQuery) {
      logger.error('VectorStoreProvider does not support executeQuery — cannot sample', {
        knowledgeBaseId,
        indexName,
      });
      return { candidates: [], sampledDocCount: 0, indexName };
    }

    let result;
    try {
      result = await this.vectorStore.executeQuery(indexName, queryBody);
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
   * Uses size up to maxCardinality to capture distinct values.
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
    return Math.round((normalizedEntropy * 0.7 + coverageFactor * 0.3) * 100) / 100 || 0;
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
