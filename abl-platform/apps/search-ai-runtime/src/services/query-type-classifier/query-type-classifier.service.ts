/**
 * Query Type Classifier Service - FR-6
 *
 * Classifies queries into one of four types: structured, semantic, hybrid, or aggregation.
 * Uses LLM with few-shot learning for accurate classification.
 *
 * **Key Features:**
 * - Four query types: structured, semantic, hybrid, aggregation
 * - Few-shot learning with connector-specific examples
 * - Fast classification using Haiku model
 * - Fallback to semantic query on error
 * - Confidence scoring and reasoning
 * - Example caching for performance
 *
 * **Usage:**
 * ```typescript
 * const classifier = new QueryTypeClassifier(llmClient);
 * const result = await classifier.classify({
 *   query: 'Show high priority bugs about login',
 *   connectorType: 'jira',
 *   tenantId: 'tenant_123',
 * });
 * // result.queryType = 'hybrid'
 * ```
 */

import type { WorkerLLMClient } from '@agent-platform/llm';
import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';
import { QUERY_TYPE_EXAMPLES } from './query-type-examples.js';

const logger = createLogger('QueryTypeClassifier');

// ─── Types ───────────────────────────────────────────────────────────────

export type QueryType = 'structured' | 'semantic' | 'hybrid' | 'aggregation';

export interface QueryClassification {
  queryType: QueryType;
  confidence: number;
  reasoning: string;
  expectedComponents: {
    filters?: string[];
    concepts?: string[];
    aggregation?: {
      function: string;
      groupBy?: string;
    };
  };
}

export interface ClassifyParams {
  query: string;
  connectorType: string;
  tenantId: string;
}

// ─── Service ─────────────────────────────────────────────────────────────

/**
 * Query Type Classifier Service
 *
 * IMPLEMENTS:
 * - FR-6: Query Type Classification
 * - Few-shot learning with examples
 * - Fast Haiku model for classification
 * - Graceful fallback on errors
 */
export class QueryTypeClassifier {
  private llmClient: WorkerLLMClient;
  private examplesCache: LRUCache<string, any>;

  constructor(llmClient: WorkerLLMClient) {
    this.llmClient = llmClient;

    // Cache classification examples (1 hour TTL, static data)
    this.examplesCache = new LRUCache({
      max: 100,
      ttl: 1000 * 60 * 60, // 1 hour
    });

    logger.info('QueryTypeClassifier initialized');
  }

  /**
   * Classify query type using LLM + examples
   */
  async classify(params: ClassifyParams): Promise<QueryClassification> {
    try {
      // 1. Load classification examples for connector
      const examples = this.loadExamples(params.connectorType);

      // 2. Build LLM prompt with examples (few-shot classification)
      const systemPrompt = this.buildClassificationPrompt(examples);

      // 3. Call LLM to classify query
      const llmResponse = await this.llmClient.chat(
        systemPrompt,
        [{ role: 'user', content: `Query: "${params.query}"` }],
        {
          model: 'claude-3-5-haiku-20241022', // Fast classification
          maxTokens: 500,
        },
      );

      // 4. Parse classification result from JSON
      const classification = this.parseClassificationResult(llmResponse);

      logger.info('Query classified', {
        query: params.query,
        queryType: classification.queryType,
        confidence: classification.confidence,
      });

      return classification;
    } catch (error) {
      logger.error('Query classification failed', {
        error: error instanceof Error ? error.message : String(error),
        query: params.query,
      });

      // Fallback: Default to semantic query
      return {
        queryType: 'semantic',
        confidence: 0.5,
        reasoning: 'Classification failed, defaulting to semantic search',
        expectedComponents: {},
      };
    }
  }

  /**
   * Load classification examples from config
   */
  private loadExamples(connectorType: string): any {
    const cacheKey = `examples:${connectorType}`;

    // Check cache
    const cached = this.examplesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Load from configuration
    const examples = QUERY_TYPE_EXAMPLES[connectorType] || QUERY_TYPE_EXAMPLES.generic;

    this.examplesCache.set(cacheKey, examples);
    return examples;
  }

  /**
   * Build classification prompt with few-shot examples
   */
  private buildClassificationPrompt(examples: any): string {
    return `You are a query type classifier. Given a user query, classify it into one of four types:

1. **structured**: Queries with field filters, no semantic concepts
   Keywords: show, list, find, get, filter, where

2. **semantic**: Queries about concepts, requires vector search
   Keywords: about, related to, regarding, concerning

3. **hybrid**: Queries combining structured filters AND semantic concepts
   Keywords: show...about, list...related to, find...regarding

4. **aggregation**: Queries with counting, summing, or grouping
   Keywords: count, total, sum, average, by, per, group by

## Examples

### Structured Queries
${this.formatExamples(examples.structured.examples)}

### Semantic Queries
${this.formatExamples(examples.semantic.examples)}

### Hybrid Queries
${this.formatExamples(examples.hybrid.examples)}

### Aggregation Queries
${this.formatExamples(examples.aggregation.examples)}

## Output Format

Return a JSON object with the following structure:
\`\`\`json
{
  "queryType": "structured|semantic|hybrid|aggregation",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "expectedComponents": {
    "filters": ["field1", "field2"],
    "concepts": ["concept1"],
    "aggregation": {
      "function": "count|sum|avg",
      "groupBy": "field"
    }
  }
}
\`\`\`

Ensure the JSON is valid and includes all required fields (queryType, confidence, reasoning).`;
  }

  /**
   * Format examples for prompt
   */
  private formatExamples(examples: any[]): string {
    return examples
      .map(
        (ex) =>
          `- Query: "${ex.query}"
  Classification: ${ex.queryType || 'structured'}
  Reasoning: ${ex.reasoning}
  Confidence: ${ex.confidence}`,
      )
      .join('\n\n');
  }

  /**
   * Parse classification result from LLM text response
   */
  private parseClassificationResult(llmResponse: string): QueryClassification {
    try {
      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const result = JSON.parse(jsonMatch[0]);

      // Validate required fields
      if (!result.queryType || !result.confidence || !result.reasoning) {
        throw new Error('Missing required fields in classification result');
      }

      return {
        queryType: result.queryType,
        confidence: result.confidence,
        reasoning: result.reasoning,
        expectedComponents: result.expectedComponents || {},
      };
    } catch (error) {
      logger.error('Failed to parse classification result', {
        error: error instanceof Error ? error.message : String(error),
        response: llmResponse,
      });
      throw new Error('Failed to parse LLM classification response');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.examplesCache.size,
      maxSize: this.examplesCache.max,
    };
  }

  /**
   * Clear examples cache
   */
  clearCache(): void {
    this.examplesCache.clear();
    logger.info('Examples cache cleared');
  }
}
