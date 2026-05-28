/**
 * Dynamic Vocabulary Resolver - RFC-SEARCHAI-001
 *
 * Resolves vocabulary terms dynamically at query time using LLM + schema injection.
 * This enables the same term to resolve to different types (filter, display, aggregate,
 * sort) based on query intent (FR-1).
 *
 * Uses provider-agnostic WorkerLLMClient for compatibility with any LLM provider.
 * Requests structured JSON output which is then validated.
 *
 * **Key Features:**
 * - LLM-based dynamic resolution (FR-1)
 * - Schema injection pattern (FR-5)
 * - Provider-agnostic (works with any LLM via WorkerLLMClient)
 * - LRU caching: vocabulary (5min), schema (10min)
 * - Graceful degradation on LLM failure
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import type {
  IVocabularyEntry,
  ICanonicalSchema,
  IDomainVocabulary,
} from '@agent-platform/database';
import { getLazyModel } from '../../db/index.js';

const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('dynamic-vocabulary-resolver');

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Dynamic Resolution Result (replaces static resolution)
 *
 * The LLM determines what type of resolution to use based on query intent.
 */
export interface DynamicResolutionResult {
  term: string;
  resolvedAs: 'filter' | 'display' | 'aggregate' | 'sort';
  confidence: number;
  reasoning: string;

  // Type-specific resolution data
  filter?: {
    field: string;
    operator: 'equals' | 'in' | 'gt' | 'lt' | 'contains';
    value: unknown;
  }[];

  display?: {
    fields: string[]; // Includes relatedFields.displayWith
  };

  aggregate?: {
    metric: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
    field: string;
    groupBy: string[];
    includeFields: string[]; // Includes relatedFields.aggregateWith
  };

  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
}

/**
 * Resolution result with unresolved segments and optional query type classification
 */
export interface VocabularyResolutionResult {
  originalQuery: string;
  resolutions: DynamicResolutionResult[];
  unresolvedSegments: string[];
  /** Query type classification from LLM (combined with vocabulary resolution in single call) */
  classifiedQueryType?: 'structured' | 'semantic' | 'hybrid' | 'aggregation';
  /** Confidence of query type classification */
  classificationConfidence?: number;
}

// ─── JSON Schema ─────────────────────────────────────────────────────────

/**
 * Expected JSON schema for LLM response.
 *
 * This is included in the prompt to guide the LLM toward producing
 * valid JSON output that we can parse and validate.
 */
interface LLMResolutionResponse {
  resolutions: Array<{
    term: string;
    resolvedAs: 'filter' | 'display' | 'aggregate' | 'sort';
    reasoning: string;
    field: string;
    value?: unknown;
    operator?: string;
    metric?: string;
    direction?: string;
  }>;
  /** Query type classification (combined with resolution in single LLM call) */
  classifiedQueryType?: 'structured' | 'semantic' | 'hybrid' | 'aggregation';
  classificationConfidence?: number;
}

// ─── Service ─────────────────────────────────────────────────────────────

/**
 * Dynamic Vocabulary Resolver with LLM + Schema Injection
 *
 * IMPLEMENTS:
 * - FR-1: Same term resolves to different types based on query context
 * - FR-5: LLM schema injection pattern
 */
export class DynamicVocabularyResolver {
  private llmClient: WorkerLLMClient;
  private vocabularyCache: LRUCache<string, IVocabularyEntry[]>;
  private schemaCache: LRUCache<string, ICanonicalSchema[]>;

  /**
   * @param llmClient - Provider-agnostic LLM client (configured for the tenant/project)
   */
  constructor(llmClient: WorkerLLMClient) {
    this.llmClient = llmClient;

    // Cache vocabulary entries (5min TTL, max 500 projects)
    this.vocabularyCache = new LRUCache({
      max: 500,
      ttl: 1000 * 60 * 5,
      updateAgeOnGet: true,
    });

    // Cache canonical schema (10min TTL, max 200 projects)
    this.schemaCache = new LRUCache({
      max: 200,
      ttl: 1000 * 60 * 10,
      updateAgeOnGet: true,
    });

    logger.info('DynamicVocabularyResolver initialized');
  }

  /**
   * Resolve vocabulary terms dynamically using LLM.
   *
   * This replaces the static resolution approach with dynamic LLM-based
   * resolution that considers query context.
   *
   * @param query - Natural language query
   * @param projectKbId - Project knowledge base ID
   * @param tenantId - Tenant ID for isolation
   * @returns Resolution result with structured resolutions and unresolved segments
   */
  async resolve(
    query: string,
    projectKbId: string,
    tenantId: string,
  ): Promise<VocabularyResolutionResult> {
    try {
      // 1. Load vocabulary entries (with capabilities, not fixed resolution)
      const vocabulary = await this.loadVocabulary(projectKbId, tenantId);

      if (vocabulary.length === 0) {
        logger.debug('No vocabulary entries found', { projectKbId, tenantId });
        return {
          originalQuery: query,
          resolutions: [],
          unresolvedSegments: query.split(/\s+/).filter((s) => s.length > 0),
        };
      }

      // 2. Load canonical schema for LLM injection (FR-5)
      const schema = await this.loadCanonicalSchema(projectKbId, tenantId);

      // 3. Build LLM prompt with schema injection (FR-5)
      const systemPrompt = this.buildSystemPrompt(vocabulary, schema);

      // 4. Call LLM to resolve vocabulary terms (FR-1)
      // Using provider-agnostic WorkerLLMClient
      const llmResponseText = await this.llmClient.chat(
        systemPrompt,
        [{ role: 'user', content: `Query: "${query}"` }],
        { maxTokens: 1000 },
      );

      // 5. Parse LLM response (extract and validate JSON)
      const parseResult = this.parseLLMResponse(llmResponseText, vocabulary);

      // 6. Extract unresolved segments
      const unresolvedSegments = this.extractUnresolvedSegments(query, parseResult.resolutions);

      logger.debug('Vocabulary resolution complete', {
        query,
        projectKbId,
        resolvedCount: parseResult.resolutions.length,
        unresolvedCount: unresolvedSegments.length,
        classifiedQueryType: parseResult.classifiedQueryType,
      });

      return {
        originalQuery: query,
        resolutions: parseResult.resolutions,
        unresolvedSegments,
        classifiedQueryType: parseResult.classifiedQueryType,
        classificationConfidence: parseResult.classificationConfidence,
      };
    } catch (error) {
      logger.error('Dynamic vocabulary resolution failed', {
        error: error instanceof Error ? error.message : String(error),
        query,
        projectKbId,
        tenantId,
      });

      // Fallback: Return empty resolution
      return {
        originalQuery: query,
        resolutions: [],
        unresolvedSegments: query.split(/\s+/).filter((s) => s.length > 0),
      };
    }
  }

  /**
   * Build system prompt with schema injection (FR-5).
   *
   * PATTERN: Schema injection (SQLCoder, Anthropic recommendations)
   * Provides complete schema context to improve LLM accuracy.
   */
  private buildSystemPrompt(vocabulary: IVocabularyEntry[], schemaDoc: ICanonicalSchema[]): string {
    // Extract fields from schema documents
    const allFields = schemaDoc.flatMap((s) => s.fields || []);

    // Build schema description for LLM
    const schemaDesc =
      allFields.length > 0
        ? allFields
            .map((field) => {
              const caps = [];
              if (field.filterable) caps.push('filter');
              if (field.indexed) caps.push('display');
              if (field.aggregatable) caps.push('aggregate');
              // Note: sortable is assumed true for indexed fields
              if (field.indexed) caps.push('sort');

              let desc = `- ${field.name}: ${field.type}`;
              if (field.enumValues && typeof field.enumValues === 'object') {
                const enumKeys = Object.keys(field.enumValues);
                if (enumKeys.length > 0) {
                  desc += ` enum [${enumKeys.slice(0, 5).join(', ')}${enumKeys.length > 5 ? ', ...' : ''}]`;
                }
              }
              desc += `\n  Capabilities: ${caps.join(', ')}`;
              desc += `\n  Description: ${field.description || 'No description'}`;
              return desc;
            })
            .join('\n\n')
        : '(No schema available - resolution will be based on vocabulary only)';

    // Build vocabulary description
    const vocabDesc = vocabulary
      .map((entry) => {
        const caps = [];
        if (entry.capabilities.canFilter) caps.push('filter');
        if (entry.capabilities.canDisplay) caps.push('display');
        if (entry.capabilities.canAggregate) caps.push('aggregate');
        if (entry.capabilities.canSort) caps.push('sort');

        return `- "${entry.term}" (aliases: ${entry.aliases.join(', ')})
  Field: ${entry.fieldRef}
  Can resolve as: ${caps.join(', ')}
  Related fields (display): ${entry.relatedFields.displayWith.slice(0, 3).join(', ')}
  Related fields (aggregate): ${entry.relatedFields.aggregateWith.join(', ')}`;
      })
      .join('\n\n');

    return `You are a query vocabulary resolver. Given a natural language query and a schema, determine how each vocabulary term should resolve based on query intent.

## Schema (Fields Available)

${schemaDesc}

## Vocabulary (Terms Users Can Use)

${vocabDesc}

## Resolution Rules

1. **Filter** (PREFERRED for canFilter fields) - When query CLEARLY mentions a field with a specific value
   - Keywords: "filter", "where", "with", "only", "show", "find", "assigned to", "by"
   - IMPORTANT: When a field is canFilter AND the query provides a value, ALWAYS resolve as filter
   - Example: "find documents assigned to John" → assignee resolves as filter (value: "John")
   - Example: "show me critical severity bugs" → severity resolves as filter (value: "critical")
   - Example: "pdf documents" → mime_type resolves as filter (value: "application/pdf")
   - Extract the ACTUAL VALUE from the query, not the field name
   - CRITICAL: Do NOT extract a word as a filter value if it is NOT a plausible value for that field.
     For example, if the field is "colour" with known values [brown, green, white], do NOT
     extract "formal" or "latest" as colour values — those are descriptors, not colours.
     When in doubt, prefer semantic search over false filter extraction.

2. **Display** - ONLY when query asks to show/view a field WITHOUT a specific value
   - Keywords: "show field", "display column", "what is the"
   - Example: "show me the priority field" → priority resolves as display (no value)
   - Do NOT use display when a filter value is present in the query

3. **Aggregate** - When query indicates grouping/counting/summing
   - Keywords: "count", "sum", "average", "total", "by", "group by", "per"
   - Example: "count by priority" → priority resolves as aggregate

4. **Sort** - When query indicates ordering
   - Keywords: "sort", "order", "highest", "lowest", "top", "bottom"
   - Example: "sort by priority" → priority resolves as sort

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanations) with this structure:

\`\`\`json
{
  "classifiedQueryType": "structured|semantic|hybrid|aggregation",
  "classificationConfidence": 0.95,
  "resolutions": [
    {
      "term": "vocabulary term from the query",
      "resolvedAs": "filter|display|aggregate|sort",
      "reasoning": "why this resolution was chosen",
      "field": "canonical field name",
      "value": "value for filters (optional)",
      "operator": "equals|in|gt|lt|contains (for filters, optional)",
      "metric": "count|sum|avg|min|max|count_distinct (for aggregates, optional)",
      "direction": "asc|desc (for sorts, optional)"
    }
  ]
}
\`\`\`

## Query Type Classification Rules

Classify the overall query into one of these types:
- **structured** - Query ONLY uses explicit field filters, no semantic/conceptual search needed
- **semantic** - Query is about concepts/topics/descriptions, requires vector search. If NO field values are clearly identifiable, classify as semantic even if vocabulary terms exist.
- **hybrid** - Query combines explicit field filters AND semantic concepts (most common)
- **aggregation** - Query asks for counts, sums, averages, or grouping
When no clear filter values are present in the query, prefer semantic over structured.

IMPORTANT:
- Respond ONLY with valid JSON
- Always include classifiedQueryType at the top level
- Same term can resolve differently based on context
- Include related fields when resolving as display or aggregate
- Provide clear reasoning for each resolution decision`;
  }

  /**
   * Parse LLM response and build resolution results.
   *
   * Extracts JSON from text response and validates the structure.
   */
  private parseLLMResponse(
    llmResponseText: string,
    vocabulary: IVocabularyEntry[],
  ): {
    resolutions: DynamicResolutionResult[];
    classifiedQueryType?: 'structured' | 'semantic' | 'hybrid' | 'aggregation';
    classificationConfidence?: number;
  } {
    try {
      // Extract JSON from response (handle markdown code fences if present)
      const jsonMatch =
        llmResponseText.match(/```json\n([\s\S]*?)\n```/) || llmResponseText.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        logger.warn('No valid JSON found in LLM response');
        return { resolutions: [] };
      }

      const jsonText = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonText) as LLMResolutionResponse;

      if (!parsed.resolutions || !Array.isArray(parsed.resolutions)) {
        logger.warn('Invalid response structure: missing resolutions array');
        return { resolutions: [] };
      }

      const { resolutions, classifiedQueryType, classificationConfidence } = parsed;

      // Validate classifiedQueryType
      const validQueryTypes = ['structured', 'semantic', 'hybrid', 'aggregation'];
      const validatedQueryType =
        classifiedQueryType && validQueryTypes.includes(classifiedQueryType)
          ? (classifiedQueryType as 'structured' | 'semantic' | 'hybrid' | 'aggregation')
          : undefined;

      const resolvedResults = resolutions
        .map((res: any) => {
          const vocabEntry = vocabulary.find(
            (v) => v.term === res.term || v.aliases.includes(res.term),
          );

          if (!vocabEntry) {
            logger.warn('LLM resolved unknown term', { term: res.term });
            return null;
          }

          // Build type-specific resolution
          const result: DynamicResolutionResult = {
            term: res.term,
            resolvedAs: res.resolvedAs,
            confidence: res.confidence || 0.9,
            reasoning: res.reasoning,
          };

          switch (res.resolvedAs) {
            case 'display':
              result.display = {
                fields: [vocabEntry.fieldRef, ...vocabEntry.relatedFields.displayWith],
              };
              break;

            case 'filter':
              result.filter = [
                {
                  field: vocabEntry.fieldRef,
                  operator: res.operator || 'equals',
                  value: res.value,
                },
              ];
              break;

            case 'aggregate':
              result.aggregate = {
                metric: res.metric || 'count',
                field: vocabEntry.fieldRef,
                groupBy: [vocabEntry.fieldRef],
                includeFields: vocabEntry.relatedFields.aggregateWith,
              };
              break;

            case 'sort':
              result.sort = {
                field: vocabEntry.fieldRef,
                direction: res.direction || 'asc',
              };
              break;
          }

          return result;
        })
        .filter((r): r is DynamicResolutionResult => r !== null);

      return {
        resolutions: resolvedResults,
        classifiedQueryType: validatedQueryType,
        classificationConfidence:
          typeof classificationConfidence === 'number' ? classificationConfidence : undefined,
      };
    } catch (error) {
      logger.error('Failed to parse LLM response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { resolutions: [] };
    }
  }

  /**
   * Load vocabulary entries (cached).
   *
   * Uses LRU cache with 5min TTL to reduce database load.
   */
  private async loadVocabulary(projectKbId: string, tenantId: string): Promise<IVocabularyEntry[]> {
    const cacheKey = `${tenantId}:${projectKbId}`;

    // Check cache
    const cached = this.vocabularyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Load from database
    const doc = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: projectKbId,
      tenantId,
      status: 'active',
    })
      .sort({ version: -1 })
      .lean();

    if (!doc || !doc.entries) {
      const empty: IVocabularyEntry[] = [];
      this.vocabularyCache.set(cacheKey, empty);
      return empty;
    }

    const entries: IVocabularyEntry[] = doc.entries.filter((e: IVocabularyEntry) => e.enabled);

    this.vocabularyCache.set(cacheKey, entries);
    return entries;
  }

  /**
   * Load canonical schema for LLM injection (FR-5).
   *
   * Uses LRU cache with 10min TTL. Schema changes are less frequent
   * than vocabulary, so longer TTL is appropriate.
   */
  private async loadCanonicalSchema(
    projectKbId: string,
    tenantId: string,
  ): Promise<ICanonicalSchema[]> {
    const cacheKey = `schema:${tenantId}:${projectKbId}`;

    // Check cache
    const cached = this.schemaCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Load from existing canonical-mapping service
    // NOTE: This reuses existing schema, doesn't create new collection
    const schema = await this.loadCanonicalSchemaFromExistingService(projectKbId, tenantId);

    this.schemaCache.set(cacheKey, schema);
    return schema;
  }

  /**
   * Load canonical schema from existing canonical-mapping service.
   *
   * TODO: Import from existing canonical-mapping service.
   * For now, returns empty array as the canonical-mapping service
   * will be integrated in a later phase.
   */
  private async loadCanonicalSchemaFromExistingService(
    projectKbId: string,
    tenantId: string,
  ): Promise<ICanonicalSchema[]> {
    try {
      const { getModel } = await import('../../db/index.js');
      const CanonicalSchemaModel = getModel<ICanonicalSchema>('CanonicalSchema');
      const schema = await CanonicalSchemaModel.findOne({
        knowledgeBaseId: projectKbId,
        tenantId,
      }).lean();

      if (schema?.fields) {
        return schema.fields as unknown as ICanonicalSchema[];
      }
      return [];
    } catch (error) {
      logger.warn('Failed to load canonical schema', {
        error: error instanceof Error ? error.message : String(error),
        projectKbId,
      });
      return [];
    }
  }

  /**
   * Extract unresolved segments from query.
   *
   * Removes resolved terms from the query and returns the remaining
   * segments for fallback processing.
   */
  private extractUnresolvedSegments(
    query: string,
    resolutions: DynamicResolutionResult[],
  ): string[] {
    let remaining = query.toLowerCase();

    for (const resolution of resolutions) {
      // Escape special regex characters in term
      const pattern = new RegExp(resolution.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      remaining = remaining.replace(pattern, ' ');
    }

    return remaining
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);
  }

  /**
   * Clear all caches.
   *
   * Useful for testing or when vocabulary/schema is updated.
   */
  clearCaches(): void {
    this.vocabularyCache.clear();
    this.schemaCache.clear();
    logger.info('Caches cleared');
  }

  /**
   * Get cache statistics.
   *
   * Useful for monitoring and debugging.
   */
  getCacheStats() {
    return {
      vocabulary: {
        size: this.vocabularyCache.size,
        max: this.vocabularyCache.max,
      },
      schema: {
        size: this.schemaCache.size,
        max: this.schemaCache.max,
      },
    };
  }
}
