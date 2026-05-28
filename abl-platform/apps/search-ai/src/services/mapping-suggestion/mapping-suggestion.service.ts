/**
 * Mapping Suggestion Service
 *
 * Uses LLM to suggest field mappings from source connector schema to canonical schema.
 * Includes circuit breaker for resilience and confidence scoring for each suggestion.
 */

import {
  type IConnectorSchemaField,
  type ICanonicalField,
  type IFieldMapping,
} from '@agent-platform/database/models';
import { getTemplateForConnector } from '@agent-platform/search-ai-internal/canonical';
import { resolveIndexLLMConfig } from '../llm-config/resolver.js';
import { createLogger } from '@abl/compiler/platform';
import { WorkerLLMClient } from '@agent-platform/llm';
import {
  CircuitBreakerRegistry,
  CircuitOpenError,
  type BreakerState,
} from '@agent-platform/circuit-breaker';
import { getCircuitBreakerRegistry } from './circuit-breaker-registry.js';
import { PromptLoaderService } from '../prompts/prompt-loader.service.js';

const logger = createLogger('mapping-suggestion');

const promptLoader = new PromptLoaderService();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MappingSuggestion {
  canonicalField: string;
  sourcePath: string;
  transform: {
    type: 'direct' | 'lowercase' | 'uppercase' | 'split' | 'join' | 'parse_date' | 'value_map';
    valueMap?: Record<string, string>;
    delimiter?: string;
    sourceFormat?: string;
  };
  confidence: number;
  reasoning: string;
  /** Suggested business-friendly alias name for the canonical field */
  suggestedAlias?: string;
  /** Suggested display label for the alias */
  suggestedLabel?: string;
}

export interface MappingSuggestionRequest {
  sourceFields: IConnectorSchemaField[];
  canonicalFields: ICanonicalField[];
  connectorType: string;
  existingMappings?: IFieldMapping[];
}

export interface MappingSuggestionResponse {
  suggestions: MappingSuggestion[];
  totalProcessed: number;
  averageConfidence: number;
  processingTimeMs: number;
}

export interface CircuitStatusResponse {
  provider: string;
  state: BreakerState;
  failureCount: number;
  successCount: number;
  totalCount: number;
  failureRate: number;
  retryAfterMs?: number;
  openedAt: number | null;
}

// ─── Provider Fallback Map ───────────────────────────────────────────────────

const PROVIDER_FALLBACK_MAP: Record<string, string> = {
  anthropic: 'openai',
  openai: 'anthropic',
  gemini: 'openai',
};

// ─── Redis-Backed Circuit Breaker (Singleton) ────────────────────────────────

// ─── Service ─────────────────────────────────────────────────────────────────

export class MappingSuggestionService {
  /**
   * Suggest field mappings from source schema to canonical schema.
   *
   * Uses Redis-backed circuit breaker for distributed resilience.
   * When the primary LLM provider's circuit opens, attempts fallback to an
   * alternate provider. Returns empty suggestions (graceful degradation) when
   * both primary and fallback are unavailable.
   *
   * @param tenantId - Tenant ID for LLM credential resolution (BYOK)
   * @param indexId - Search index ID for LLM config resolution
   * @param request - Mapping suggestion request
   * @returns Mapping suggestions with confidence scores
   */
  async suggestMappings(
    tenantId: string,
    indexId: string,
    request: MappingSuggestionRequest,
  ): Promise<MappingSuggestionResponse> {
    const startTime = Date.now();

    // M-1 FIX: Validate field counts before processing
    if (request.sourceFields.length > 200) {
      logger.warn('Too many source fields for mapping suggestion', {
        indexId,
        sourceFieldCount: request.sourceFields.length,
        limit: 200,
      });
      return {
        suggestions: [],
        totalProcessed: 0,
        averageConfidence: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    if (request.canonicalFields.length > 75) {
      logger.warn('Too many canonical fields for mapping suggestion', {
        indexId,
        canonicalFieldCount: request.canonicalFields.length,
        limit: 75,
      });
      return {
        suggestions: [],
        totalProcessed: 0,
        averageConfidence: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    logger.info('Generating mapping suggestions', {
      tenantId,
      indexId,
      sourceFieldCount: request.sourceFields.length,
      canonicalFieldCount: request.canonicalFields.length,
      connectorType: request.connectorType,
    });

    // Resolve LLM config using tenant-specific credentials (BYOK)
    const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
    const useCaseConfig = llmConfig.useCases?.mapping_suggestion;

    if (!useCaseConfig?.apiKey) {
      logger.warn('No LLM configured for mapping suggestions', { tenantId, indexId });
      return {
        suggestions: [],
        totalProcessed: 0,
        averageConfidence: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    const provider = useCaseConfig.provider;

    // Create provider-agnostic LLM client
    const llmClient = new WorkerLLMClient(provider, useCaseConfig.apiKey, useCaseConfig.model);

    // Attempt LLM call with circuit breaker protection
    const registry = getCircuitBreakerRegistry();

    try {
      let suggestions: MappingSuggestion[];

      if (registry) {
        try {
          suggestions = await registry
            .llmProvider(tenantId, provider)
            .execute(() => this.generateSuggestions(llmClient, request));
        } catch (error) {
          if (error instanceof CircuitOpenError) {
            // Primary provider circuit is open -- attempt fallback
            logger.info('Attempting LLM provider fallback', {
              primary: provider,
              fallback: PROVIDER_FALLBACK_MAP[provider] || 'none',
              tenantId,
            });

            suggestions = await this.attemptFallback(
              tenantId,
              indexId,
              provider,
              request,
              registry,
            );
          } else {
            throw error;
          }
        }
      } else {
        // No Redis available -- execute without circuit breaker
        suggestions = await this.generateSuggestions(llmClient, request);
      }

      const averageConfidence =
        suggestions.length > 0
          ? suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length
          : 0;

      const processingTimeMs = Date.now() - startTime;

      logger.info('Mapping suggestions generated', {
        tenantId,
        indexId,
        suggestionsCount: suggestions.length,
        averageConfidence: averageConfidence.toFixed(2),
        processingTimeMs,
      });

      return {
        suggestions,
        totalProcessed: request.sourceFields.length,
        averageConfidence,
        processingTimeMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to generate mapping suggestions', {
        tenantId,
        indexId,
        error: errorMessage,
      });

      // Return empty suggestions on failure (graceful degradation)
      return {
        suggestions: [],
        totalProcessed: 0,
        averageConfidence: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Attempt fallback to an alternate LLM provider when primary circuit is open.
   *
   * @param tenantId - Tenant ID
   * @param indexId - Search index ID
   * @param primaryProvider - The provider whose circuit is open
   * @param request - Mapping suggestion request
   * @param registry - Circuit breaker registry
   * @returns Suggestions from fallback provider, or empty array
   */
  private async attemptFallback(
    tenantId: string,
    indexId: string,
    primaryProvider: string,
    request: MappingSuggestionRequest,
    registry: CircuitBreakerRegistry,
  ): Promise<MappingSuggestion[]> {
    const fallbackProvider = PROVIDER_FALLBACK_MAP[primaryProvider];
    if (!fallbackProvider) {
      logger.warn('No fallback provider available', { primaryProvider, tenantId });
      return [];
    }

    try {
      // Attempt to resolve fallback provider config
      const fallbackConfig = await resolveIndexLLMConfig(tenantId, indexId);
      const fallbackUseCaseConfig = fallbackConfig.useCases?.mapping_suggestion;

      // Check if fallback provider has credentials configured
      if (!fallbackUseCaseConfig?.apiKey) {
        logger.warn('Fallback provider not configured for tenant', {
          fallbackProvider,
          tenantId,
        });
        return [];
      }

      const fallbackClient = new WorkerLLMClient(
        fallbackProvider,
        fallbackUseCaseConfig.apiKey,
        fallbackUseCaseConfig.model,
      );

      const suggestions = await registry
        .llmProvider(tenantId, fallbackProvider)
        .execute(() => this.generateSuggestions(fallbackClient, request));

      logger.info('Fallback provider succeeded', {
        primaryProvider,
        fallbackProvider,
        tenantId,
        suggestionsCount: suggestions.length,
      });

      return suggestions;
    } catch (fallbackError) {
      const errorMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logger.warn('Fallback provider also failed', {
        primaryProvider,
        fallbackProvider,
        tenantId,
        error: errorMessage,
      });
      return [];
    }
  }

  /**
   * Get circuit breaker status for a tenant's LLM provider.
   *
   * @param tenantId - Tenant ID
   * @param provider - LLM provider name
   * @returns Circuit breaker status or null if unavailable
   */
  async getCircuitBreakerStatus(
    tenantId: string,
    provider: string,
  ): Promise<CircuitStatusResponse | null> {
    const registry = getCircuitBreakerRegistry();
    if (!registry) {
      return null;
    }

    try {
      const handle = registry.llmProvider(tenantId, provider);
      const metrics = await handle.getMetrics();
      const stateResult = await handle.checkState();

      return {
        provider,
        state: metrics.state,
        failureCount: metrics.failureCount,
        successCount: metrics.successCount,
        totalCount: metrics.totalCount,
        failureRate: metrics.failureRate,
        retryAfterMs: stateResult.retryAfterMs > 0 ? stateResult.retryAfterMs : undefined,
        openedAt: metrics.openedAt,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get circuit breaker status', {
        tenantId,
        provider,
        error: errorMessage,
      });
      return null;
    }
  }

  /**
   * Generate suggestions using provider-agnostic LLM client (Vercel AI SDK).
   *
   * @param llmClient - WorkerLLMClient instance (supports Anthropic, OpenAI, Google, Azure, etc.)
   * @param request - Mapping request
   * @returns Array of mapping suggestions
   */
  private async generateSuggestions(
    llmClient: WorkerLLMClient,
    request: MappingSuggestionRequest,
  ): Promise<MappingSuggestion[]> {
    const promptDef = promptLoader.loadPrompt('mapping-suggestion', 1);
    const userPrompt = this.buildPrompt(request, promptDef.user_prompt_template!);
    const systemPrompt = promptDef.system_prompt.trim();

    const responseText = await llmClient.chat(
      systemPrompt,
      [{ role: 'user', content: userPrompt }],
      {
        timeoutMs: 120_000,
      },
    );

    return this.parseResponse(responseText);
  }

  /**
   * Sanitize field objects to prevent prompt injection.
   * Removes potentially malicious content and limits string lengths.
   * Includes enumValues when present on source fields (limited to 20, each 100 chars).
   *
   * @param fields - Fields to sanitize
   * @returns Sanitized fields
   */
  private sanitizeFields(
    fields: IConnectorSchemaField[] | ICanonicalField[],
  ): Array<{ path: string; label: string; type: string; enumValues?: string[] }> {
    return fields.map((field) => {
      // IConnectorSchemaField has 'path', ICanonicalField has 'name'
      const fieldPath = ('path' in field ? field.path : field.name) || '';
      const result: { path: string; label: string; type: string; enumValues?: string[] } = {
        path: this.sanitizeString(fieldPath, 200),
        label: this.sanitizeString(field.label || fieldPath, 100),
        type: this.sanitizeString(field.type || 'string', 50),
      };

      // Include enumValues for source fields (IConnectorSchemaField)
      if ('enumValues' in field && Array.isArray(field.enumValues) && field.enumValues.length > 0) {
        result.enumValues = field.enumValues
          .slice(0, 20)
          .map((val: string) => this.sanitizeString(String(val), 100));
      }

      return result;
    });
  }

  /**
   * Sanitize mapping objects to prevent prompt injection.
   *
   * @param mappings - Mappings to sanitize
   * @returns Sanitized mappings
   */
  private sanitizeMappings(
    mappings: IFieldMapping[],
  ): Array<{ sourcePath: string; canonicalField: string }> {
    return mappings.map((m) => ({
      sourcePath: this.sanitizeString(m.sourcePath || '', 200),
      canonicalField: this.sanitizeString(m.canonicalField || '', 100),
    }));
  }

  /**
   * Sanitize a string by removing control characters, limiting length,
   * and preventing common injection patterns.
   *
   * @param str - String to sanitize
   * @param maxLength - Maximum allowed length
   * @returns Sanitized string
   */
  private sanitizeString(str: string, maxLength: number): string {
    if (typeof str !== 'string') return '';

    return (
      str
        // Remove control characters except newline/tab
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Remove potential injection patterns (backticks, prompt escape attempts)
        .replace(/```/g, '')
        .replace(/\n\n+/g, '\n')
        // Trim and limit length
        .trim()
        .slice(0, maxLength)
    );
  }

  /**
   * Build prompt for LLM mapping suggestion.
   *
   * @param request - Mapping request
   * @returns Formatted prompt
   */
  private buildPrompt(request: MappingSuggestionRequest, template: string): string {
    // M-1 FIX: Sanitize and limit fields to prevent prompt injection
    const sanitizedSourceFields = this.sanitizeFields(request.sourceFields).slice(0, 200);
    const sanitizedCanonicalFields = this.sanitizeFields(request.canonicalFields).slice(0, 75);
    const sanitizedExistingMappings = request.existingMappings
      ? this.sanitizeMappings(request.existingMappings).slice(0, 100)
      : [];

    const sourceFieldsJson = JSON.stringify(sanitizedSourceFields, null, 2);
    const canonicalFieldsJson = JSON.stringify(sanitizedCanonicalFields, null, 2);
    const existingMappingsJson =
      sanitizedExistingMappings.length > 0
        ? JSON.stringify(sanitizedExistingMappings, null, 2)
        : 'None';

    // Load connector type template for field pattern hints
    const connectorTemplate = getTemplateForConnector(request.connectorType);
    const templateHints =
      connectorTemplate.category !== 'generic'
        ? `\n**Connector Category:** ${connectorTemplate.label} (${connectorTemplate.category})\n**Typical field patterns for this category:**\n${Object.entries(
            connectorTemplate.fieldPatterns,
          )
            .map(
              ([canonical, patterns]) =>
                `- ${canonical}: commonly named ${(patterns as string[]).slice(0, 3).join(', ')}`,
            )
            .join(
              '\n',
            )}\n\nUse these patterns to auto-match standard fields with high confidence. Focus LLM effort on custom fields that don't match any pattern.\n`
        : '';

    // Build enum pattern hints from connector type template
    let enumHints = '';
    if (connectorTemplate.enumPatterns && Object.keys(connectorTemplate.enumPatterns).length > 0) {
      const enumEntries = Object.entries(connectorTemplate.enumPatterns)
        .map(([canonicalField, pattern]) => {
          const valuesStr = pattern.values.join(', ');
          const displayStr = pattern.displayNames
            ? ` (display: ${Object.entries(pattern.displayNames)
                .map(([k, v]) => `${k}→${v}`)
                .join(', ')})`
            : '';
          return `- ${canonicalField}: [${valuesStr}]${displayStr}`;
        })
        .join('\n');

      enumHints = `\n**Canonical Enum Patterns (target values for value_map transforms):**\n${enumEntries}\n`;
    }

    return promptLoader.renderPrompt(template, {
      connectorType: request.connectorType,
      templateHints,
      enumHints,
      sourceFieldsJson,
      canonicalFieldsJson,
      existingMappingsJson,
    });
  }

  /**
   * Parse LLM response into mapping suggestions.
   * Hardens extraction of valueMap, suggestedAlias, and suggestedLabel.
   *
   * @param response - Raw LLM response text
   * @returns Parsed suggestions
   */
  private parseResponse(response: string): MappingSuggestion[] {
    try {
      // Extract JSON from code blocks if present
      const jsonMatch = response.match(/```(?:json)?\n([\s\S]+?)\n```/);
      const jsonText = jsonMatch ? jsonMatch[1] : response;

      const parsed = JSON.parse(jsonText);

      if (!Array.isArray(parsed)) {
        throw new Error('Expected array response from LLM');
      }

      return parsed
        .filter((item) => this.isValidSuggestion(item))
        .map((item) => {
          // Build transform with valueMap validation
          let transform = item.transform || { type: 'direct' as const };

          if (transform.type === 'value_map') {
            if (this.isValidValueMap(transform.valueMap)) {
              // Limit valueMap to 50 entries
              const entries = Object.entries(transform.valueMap).slice(0, 50);
              transform = {
                ...transform,
                valueMap: Object.fromEntries(entries),
              };
            } else {
              // Downgrade to direct if valueMap is invalid/missing
              transform = { type: 'direct' as const };
            }
          }

          return {
            canonicalField: item.canonicalField,
            sourcePath: item.sourcePath,
            transform: {
              type: transform.type,
              ...(transform.valueMap ? { valueMap: transform.valueMap } : {}),
              ...(transform.delimiter ? { delimiter: String(transform.delimiter) } : {}),
              ...(transform.sourceFormat ? { sourceFormat: String(transform.sourceFormat) } : {}),
            },
            confidence: item.confidence,
            reasoning: item.reasoning || '',
            suggestedAlias: this.sanitizeAlias(item.suggestedAlias),
            suggestedLabel: this.sanitizeLabel(item.suggestedLabel),
          };
        });
    } catch (error) {
      logger.error('Failed to parse LLM response', {
        error: error instanceof Error ? error.message : String(error),
        response: response.slice(0, 500),
      });
      return [];
    }
  }

  /**
   * Validate a mapping suggestion object.
   *
   * @param item - Potential suggestion
   * @returns True if valid
   */
  private isValidSuggestion(item: any): boolean {
    return (
      item &&
      typeof item.canonicalField === 'string' &&
      typeof item.sourcePath === 'string' &&
      typeof item.confidence === 'number' &&
      item.confidence >= 0.5 &&
      item.confidence <= 1.0 &&
      item.transform &&
      typeof item.transform.type === 'string'
    );
  }

  /**
   * Validate that a valueMap is a valid Record<string, string> with reasonable size.
   *
   * @param valueMap - Value to validate
   * @returns True if valid valueMap
   */
  private isValidValueMap(valueMap: unknown): valueMap is Record<string, string> {
    if (!valueMap || typeof valueMap !== 'object' || Array.isArray(valueMap)) {
      return false;
    }

    const entries = Object.entries(valueMap as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 50) {
      return false;
    }

    return entries.every(([key, value]) => typeof key === 'string' && typeof value === 'string');
  }

  /**
   * Sanitize and validate a suggested alias name.
   * Must be snake_case, max 50 chars, only [a-z0-9_].
   *
   * @param alias - Raw alias from LLM
   * @returns Sanitized alias or undefined if invalid
   */
  private sanitizeAlias(alias: unknown): string | undefined {
    if (typeof alias !== 'string' || !alias.trim()) {
      return undefined;
    }

    // Normalize: lowercase, replace non-alphanumeric with underscore
    const normalized = alias
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50);

    return normalized.length > 0 ? normalized : undefined;
  }

  /**
   * Sanitize and validate a suggested display label.
   * Must be a string, max 100 chars.
   *
   * @param label - Raw label from LLM
   * @returns Sanitized label or undefined if invalid
   */
  private sanitizeLabel(label: unknown): string | undefined {
    if (typeof label !== 'string' || !label.trim()) {
      return undefined;
    }

    const trimmed = label.trim().slice(0, 100);
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

export const mappingSuggestionService = new MappingSuggestionService();
