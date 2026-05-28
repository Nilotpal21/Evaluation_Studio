/**
 * Discovery Route
 *
 * GET /api/search/:indexId/discover — Returns a self-describing capability manifest
 * for a knowledge base. Used by agents at session start to discover what features
 * are available (vocabulary, classification, filters, aggregation, reranking).
 *
 * Each capability includes:
 * - Whether it's available (based on backend data)
 * - How to use it (description + examples)
 * - When to skip it (guidance for the agent)
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { createLogger } from '@abl/compiler/platform';
import type {
  ISearchIndex,
  IDomainVocabulary,
  ICanonicalSchema,
} from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
import { QUERY_TYPE_EXAMPLES } from '../services/query-type-classifier/query-type-examples.js';
import { serviceContainer } from '../services/service-container.js';
import { getModel } from '../db/index.js';
import { LRUCache } from 'lru-cache';

const logger = createLogger('search-runtime-discover');

/**
 * Resolve the OpenSearch index name from the IndexRegistry.
 * Falls back to using indexId directly.
 */
async function resolveOsIndexName(indexId: string): Promise<string> {
  try {
    const IndexRegistry = getModel('IndexRegistry');
    const entry = await IndexRegistry.findOne({ appId: indexId, status: 'active' })
      .select('indexName')
      .lean();
    if (entry && (entry as any).indexName) return (entry as any).indexName as string;
  } catch {
    // IndexRegistry not available
  }
  return indexId;
}

/**
 * Map from canonical field names to the actual metadata paths in OpenSearch.
 * Canonical fields are stored under metadata.canonical.
 */
const CANONICAL_TO_METADATA_PATH: Record<string, string> = {
  source_type: 'metadata.canonical.source_type',
  mime_type: 'metadata.canonical.mime_type',
  language: 'metadata.canonical.language',
  title: 'metadata.canonical.title',
  status: 'metadata.canonical.status',
  author: 'metadata.canonical.author',
};

/**
 * Derive a user-friendly source_type value from a MIME content type.
 * E.g., "application/pdf" → "pdf", "text/markdown" → "markdown"
 */
function deriveSourceType(contentType: string): string {
  const mimeMap: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/markdown': 'markdown',
    'text/plain': 'text',
    'text/html': 'html',
    'text/csv': 'csv',
    'application/json': 'json',
    'image/png': 'image',
    'image/jpeg': 'image',
  };
  return mimeMap[contentType] || contentType.split('/').pop() || contentType;
}

/**
 * Fetch distinct values for filterable fields from OpenSearch.
 *
 * Canonical fields are NOT indexed in OpenSearch (mapping is `dynamic: strict`).
 * Instead, we sample documents and extract values from metadata.doc / metadata.sys
 * paths, mapping them to canonical field names.
 */
async function fetchFilterFieldValues(
  indexId: string,
  fieldNames: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (fieldNames.length === 0) return result;

  try {
    const { vectorStore } = serviceContainer.getPipelineOptions();
    if (!vectorStore?.executeQuery) return result;

    const collectionName = await resolveOsIndexName(indexId);

    // Fetch a sample of documents scoped to THIS index only.
    // The OpenSearch index is a shared pool (search-vectors-{dims}-v1) —
    // without filtering by appId, match_all returns docs from ALL KBs,
    // polluting filter values with unrelated source types, authors, etc.
    const osResult = await vectorStore.executeQuery(collectionName, {
      size: 200,
      _source: ['metadata.canonical', 'metadata.doc', 'metadata.sys'],
      query: {
        bool: {
          filter: [{ term: { 'metadata.sys.appId': indexId } }],
        },
      },
    });

    // Extract distinct values per canonical field from the sample
    const fieldValueSets = new Map<string, Set<string>>();
    for (const fieldName of fieldNames) {
      fieldValueSets.set(fieldName, new Set<string>());
    }

    for (const hit of osResult.hits) {
      const canonical = (hit.source as any)?.metadata?.canonical;
      const doc = (hit.source as any)?.metadata?.doc;
      if (!canonical && !doc) continue;

      for (const fieldName of fieldNames) {
        // Try canonical path first (new structure)
        if (canonical) {
          const val = canonical[fieldName];
          if (val != null && val !== '') {
            fieldValueSets.get(fieldName)!.add(String(val));
            continue;
          }
        }

        // Fallback to old structure: derive source_type from doc.contentType
        if (fieldName === 'source_type' && doc?.contentType) {
          fieldValueSets.get(fieldName)!.add(deriveSourceType(doc.contentType));
          continue;
        }

        // Check metadata path mapping for other fields
        const metaPath = CANONICAL_TO_METADATA_PATH[fieldName];
        if (metaPath && doc) {
          // Extract value from nested path (e.g., "metadata.doc.language" → doc.language)
          const parts = metaPath.split('.');
          const lastPart = parts[parts.length - 1];
          const val = doc[lastPart];
          if (val != null && val !== '') {
            fieldValueSets.get(fieldName)!.add(String(val));
          }
        }
      }
    }

    // Convert sets to sorted arrays (up to 20 values per field)
    for (const [fieldName, valueSet] of fieldValueSets.entries()) {
      if (valueSet.size > 0) {
        const sorted = [...valueSet].sort().slice(0, 20);
        result.set(fieldName, sorted);
      }
    }

    logger.info('Filter field values fetched from OpenSearch', {
      documentsScanned: osResult.hits.length,
      fieldsWithValues: result.size,
      fields: [...result.entries()]
        .map(([k, v]) => `${k}(${v.length}): ${JSON.stringify(v)}`)
        .slice(0, 10),
    });
  } catch (err) {
    logger.warn('Failed to fetch filter field values from OpenSearch', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

// ─── Discovery Response Cache ────────────────────────────────────────────

const discoveryCache = new LRUCache<string, any>({
  max: 200,
  ttl: 1000 * 60 * 5, // 5 minutes
});

/** Invalidate discovery cache for a specific index (all tenants). */
export function invalidateDiscoveryCache(indexId: string): void {
  // Keys are `${tenantId}:${indexId}` — iterate and delete matching suffix
  for (const key of [...discoveryCache.keys()]) {
    if (key.endsWith(`:${indexId}`)) {
      discoveryCache.delete(key);
    }
  }
}

/** Invalidate ALL discovery cache entries. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

// ─── Route ───────────────────────────────────────────────────────────────

export function createDiscoverRouter(): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  /**
   * GET /:indexId/discover
   *
   * Returns a capability manifest for the knowledge base.
   * Cached for 5 minutes per tenant+index.
   */
  router.get('/:indexId/discover', async (req, res) => {
    try {
      const { indexId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Check cache
      const cacheKey = `${tenantId}:${indexId}`;
      const cached = discoveryCache.get(cacheKey);
      if (cached) {
        res.set('Cache-Control', 'public, max-age=300');
        res.set('X-Cache', 'HIT');
        res.json(cached);
        return;
      }

      // Load data sources in parallel
      // Vocabulary is the single source of truth for LLM field context.
      // CanonicalSchema is loaded only for vocabulary→field type resolution.
      const [index, vocab, schema] = await Promise.all([
        SearchIndex.findOne({ _id: indexId, tenantId }).lean(),
        DomainVocabulary.findOne({
          projectKnowledgeBaseId: indexId,
          tenantId,
          status: 'active',
        })
          .sort({ version: -1 })
          .lean(),
        CanonicalSchema.findOne({
          knowledgeBaseId: indexId,
          tenantId,
        }).lean(),
      ]);

      if (!index) {
        res.status(404).json({ error: 'Index not found' });
        return;
      }

      // Build KB metadata
      const searchDefaults = (index as any).searchDefaults ?? {};
      const kb = {
        name: (index as any).name || indexId,
        description: (index as any).description || null,
        documentCount: (index as any).documentCount || 0,
        lastUpdated: (index as any).lastIndexedAt
          ? new Date((index as any).lastIndexedAt).toISOString()
          : null,
        searchDefaults: {
          topK: searchDefaults.topK ?? 10,
        },
      };

      // Build capabilities
      const capabilities: Record<string, any> = {};

      // ─── Query Classification ─────────────────────────────────────────
      const connectorType = 'generic';
      const examples = QUERY_TYPE_EXAMPLES[connectorType] || QUERY_TYPE_EXAMPLES.generic;
      const hasExamples =
        examples &&
        examples.structured?.examples?.length > 0 &&
        examples.semantic?.examples?.length > 0;

      capabilities.queryClassification = {
        available: hasExamples,
        description: hasExamples
          ? 'You can classify the query type before searching. If you already know the intent from conversation context, set queryType directly. If you omit queryType, the pipeline will auto-classify.'
          : 'Query classification is not configured. Send queryType "hybrid" as default, or omit it for auto-classification.',
        types: {
          structured:
            'Use when the query only needs field filters (e.g., "show open P0 bugs"). No vector search needed.',
          semantic:
            'Use when the query is about concepts or topics (e.g., "how does auth work"). Pure vector search.',
          hybrid:
            'Use when the query has both filters and concepts (e.g., "high priority bugs about login"). Vector search + filters. This is the default if omitted.',
          aggregation:
            'Use when the query asks for counts, sums, or statistics (e.g., "count bugs by status").',
        },
        examples: hasExamples
          ? [
              ...examples.structured.examples.slice(0, 2).map((ex: any) => ({
                query: ex.query,
                type: 'structured',
                reasoning: ex.reasoning,
              })),
              ...examples.semantic.examples.slice(0, 2).map((ex: any) => ({
                query: ex.query,
                type: 'semantic',
                reasoning: ex.reasoning,
              })),
              ...examples.hybrid.examples.slice(0, 2).map((ex: any) => ({
                query: ex.query,
                type: 'hybrid',
                reasoning: ex.reasoning,
              })),
              ...examples.aggregation.examples.slice(0, 1).map((ex: any) => ({
                query: ex.query,
                type: 'aggregation',
                reasoning: ex.reasoning,
              })),
            ]
          : [],
        skipWhen:
          'You already know the query intent from conversation context. For example, if the user said "filter by status open", you know it\'s structured without needing classification.',
      };

      // ─── Vocabulary ───────────────────────────────────────────────────
      // Vocabulary is the SINGLE source of truth for LLM field context.
      // It provides term→field mappings, filter/aggregation capabilities,
      // and aliases — everything the LLM needs to build queries.
      const vocabEntries = vocab?.entries?.filter((e: any) => e.enabled) || [];
      const schemaFields = (schema?.fields as any[]) || [];

      // Build a field-type lookup from CanonicalSchema (for type resolution only)
      // Key by BOTH name AND storageField — vocabulary entries use fieldRef which
      // may be the storageField (e.g., "custom_string_1"), while schema fields are
      // keyed by display name (e.g., "Color"). Without both keys, discover misses
      // enumValues for JSON-mapped fields and the agent can't extract filters.
      const fieldTypeMap = new Map<string, { type: string; sortable: boolean; enumValues?: any }>();
      for (const f of schemaFields) {
        const entry = {
          type: (f as any).type || 'keyword',
          sortable: (f as any).sortable || false,
          enumValues: (f as any).enumValues,
        };
        fieldTypeMap.set((f as any).name || (f as any).storageField, entry);
        // Also key by storageField so vocabulary fieldRef lookups succeed
        if ((f as any).storageField && (f as any).storageField !== (f as any).name) {
          fieldTypeMap.set((f as any).storageField, entry);
        }
      }

      // Identify vocabulary fields that need live values from OpenSearch
      const filterableVocabEntries = vocabEntries.filter((e: any) => e.capabilities?.canFilter);
      const fieldsNeedingValues = filterableVocabEntries
        .filter((e: any) => {
          const fieldInfo = fieldTypeMap.get(e.fieldRef);
          const enumValues = fieldInfo?.enumValues;
          const hasEnum =
            enumValues && typeof enumValues === 'object' && !Array.isArray(enumValues);
          const fieldType = fieldInfo?.type || 'keyword';
          // Skip date/numeric fields and fields with pre-defined enums
          return !hasEnum && !['date', 'integer', 'long', 'float', 'double'].includes(fieldType);
        })
        .map((e: any) => e.fieldRef as string);

      // Fetch actual values from OpenSearch (single query, samples documents)
      const osFieldValues = await fetchFilterFieldValues(indexId, fieldsNeedingValues);

      capabilities.vocabulary = {
        available: vocabEntries.length > 0,
        version: vocab?.version || 0,
        description:
          vocabEntries.length > 0
            ? "These vocabulary terms map business language to searchable fields. Use them to construct precise filters when the user mentions these concepts. If the user's language doesn't match any term, just send the raw query."
            : 'No vocabulary terms are configured for this knowledge base yet. Send raw queries without filters. Vocabulary will become available after document ingestion and vocabulary generation.',
        terms: vocabEntries.slice(0, 50).map((entry: any) => {
          const fieldInfo = fieldTypeMap.get(entry.fieldRef);
          const enumValues = fieldInfo?.enumValues;
          // enumValues is Record<string, unknown> — extract display names (keys)
          const hasEnumMap =
            entry.capabilities?.canFilter && enumValues && typeof enumValues === 'object';
          const displayValues = hasEnumMap ? Object.keys(enumValues).slice(0, 10) : [];
          // Merge enum values with live OS values
          const liveValues = osFieldValues.get(entry.fieldRef) || [];
          const mergedValues = displayValues.length > 0 ? displayValues : liveValues;

          return {
            term: entry.term,
            aliases: entry.aliases || [],
            field: entry.fieldRef,
            type: fieldInfo?.type || 'keyword',
            values: mergedValues,
            enumMap: hasEnumMap
              ? Object.fromEntries(Object.entries(enumValues).slice(0, 10))
              : undefined,
            canFilter: entry.capabilities?.canFilter || false,
            canAggregate: entry.capabilities?.canAggregate || false,
            canSort: entry.capabilities?.canSort || fieldInfo?.sortable || false,
            usage:
              entry.capabilities?.canFilter && entry.aliases?.length > 0
                ? `When user mentions "${entry.term}" or "${entry.aliases[0]}", map to filter { field: "${entry.fieldRef}", operator: "equals", value: "<matched_value>" }`
                : `Maps to field: ${entry.fieldRef}`,
          };
        }),
        skipWhen:
          'The user\'s query is purely conceptual with no field-specific terms (e.g., "explain how caching works"). In this case, send the query as-is without filters.',
      };

      // ─── Filters (derived from vocabulary) ────────────────────────────
      // Filters are built from vocabulary entries with canFilter capability.
      // This ensures the LLM only sees fields that have business context.
      capabilities.filters = {
        available: filterableVocabEntries.length > 0,
        description:
          filterableVocabEntries.length > 0
            ? 'You can add metadata filters to narrow search results. Filters are AND-combined. Use vocabulary terms above to map user language to filter fields.'
            : 'No filterable fields available yet. Filters will become available after vocabulary is generated.',
        fields: filterableVocabEntries.slice(0, 30).map((entry: any) => {
          const fieldInfo = fieldTypeMap.get(entry.fieldRef);
          const enumValues = fieldInfo?.enumValues;
          const isEnumMap =
            enumValues && typeof enumValues === 'object' && !Array.isArray(enumValues);
          const values = isEnumMap
            ? Object.keys(enumValues).slice(0, 20)
            : osFieldValues.get(entry.fieldRef) || [];
          return {
            name: entry.fieldRef,
            label: entry.term !== entry.fieldRef ? entry.term : undefined,
            type: fieldInfo?.type || 'keyword',
            values,
            enumMap: isEnumMap
              ? Object.fromEntries(Object.entries(enumValues).slice(0, 20))
              : undefined,
            sortable: entry.capabilities?.canSort || fieldInfo?.sortable || false,
          };
        }),
        operators: ['equals', 'in', 'contains', 'greater_than', 'less_than'],
        skipWhen:
          'The query is purely semantic with no filtering intent. Let the vector search handle relevance.',
      };

      // ─── Aggregation (derived from vocabulary) ────────────────────────
      const aggregatableVocabEntries = vocabEntries.filter(
        (e: any) => e.capabilities?.canAggregate,
      );

      capabilities.aggregation = {
        available: aggregatableVocabEntries.length > 0,
        description:
          aggregatableVocabEntries.length > 0
            ? 'Supports count, sum, avg, min, max operations with groupBy. Use queryType "aggregation" when the user asks for statistics or counts.'
            : 'Aggregation not available. No aggregatable fields in vocabulary yet.',
        functions: ['count', 'sum', 'avg', 'min', 'max'],
        skipWhen: 'The user wants documents, not statistics.',
      };

      // ─── Reranking ────────────────────────────────────────────────────
      capabilities.reranking = {
        available: true,
        description:
          'Reranking improves result relevance for semantic and hybrid queries. Set rerank: true for better ordering. Adds ~100-200ms latency.',
        skipWhen:
          'The query is structured (exact filters) or aggregation (returns buckets, not documents), or when latency is critical.',
      };

      // ─── Preprocessing ────────────────────────────────────────────────
      capabilities.preprocessing = {
        available: true,
        description:
          'The pipeline can correct typos and expand synonyms in the query. Set skipPreprocessing: true if you have already rephrased the query using conversation context.',
        skipWhen:
          "You have already rephrased or cleaned up the user's query based on conversation context. Sending a rephrased query with preprocessing enabled may alter your intended phrasing.",
      };

      // Build response
      const response = {
        kb,
        searchDefaults: {
          topK: (index as any).searchDefaults?.topK ?? 10,
          similarityThreshold: (index as any).searchDefaults?.similarityThreshold ?? 0.2,
          ...(Array.isArray((index as any).searchDefaults?.responseFields) &&
          (index as any).searchDefaults.responseFields.length > 0
            ? { responseFields: (index as any).searchDefaults.responseFields }
            : {}),
        },
        citationConfig: (index as any).citationConfig ?? {
          enabled: true,
          linkMode: 'direct',
          linkTtlSeconds: 3600,
          maxClicks: 5,
        },
        searchEndpoint: {
          url: `/api/search/${indexId}/query`,
          method: 'POST',
          description:
            'Unified search endpoint. Send a query and optionally include queryType, filters, and other parameters. All features are optional - the pipeline handles defaults intelligently.',
        },
        capabilities,
        permissions: {
          description:
            "Pass the user's auth token in the Authorization header. The pipeline automatically applies permission filters based on the user's identity and group memberships.",
          authHeader: 'Authorization: Bearer <user-token>',
        },
        _meta: {
          version: `v${vocab?.version || 0}`,
          generatedAt: new Date().toISOString(),
          ttlSeconds: 300,
        },
      };

      // Cache response
      discoveryCache.set(cacheKey, response);

      res.set('Cache-Control', 'public, max-age=300');
      res.set('X-Cache', 'MISS');
      res.json(response);

      logger.info('Discovery manifest generated', {
        indexId,
        vocabularyTerms: vocabEntries.length,
        filterableFromVocab: filterableVocabEntries.length,
        aggregatableFromVocab: aggregatableVocabEntries.length,
        classificationAvailable: hasExamples,
      });
    } catch (error) {
      logger.error('Discovery failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /:indexId/discover/invalidate
   *
   * Flush the discovery cache for this index. Called by search-ai
   * when searchDefaults or other index config changes.
   */
  router.post('/:indexId/discover/invalidate', (req, res) => {
    const { indexId } = req.params;
    invalidateDiscoveryCache(indexId);
    logger.info('Discovery cache invalidated', { indexId });
    res.json({ success: true });
  });

  return router;
}

export default createDiscoverRouter();
