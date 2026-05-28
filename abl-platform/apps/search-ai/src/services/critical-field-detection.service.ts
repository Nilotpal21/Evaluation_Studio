/**
 * Critical Field Detection Service (FR-3)
 *
 * LLM-based service to automatically detect critical fields from connector schema samples.
 * Uses provider-agnostic WorkerLLMClient with the model configured in tenant's Model Library.
 *
 * **Key Features:**
 * - LLM-based analysis (not usage-based)
 * - Uses tenant's Model Library config (no hardcoded models)
 * - Graceful degradation: returns empty result when no LLM is configured
 * - Developer-provided examples for few-shot learning
 * - Redis caching (6-hour TTL)
 * - PII scrubbing before LLM calls
 * - Retry logic for malformed responses (max 2)
 *
 * **Usage:**
 * ```typescript
 * // With LLM configured (from Model Library via resolveIndexLLMConfig)
 * const service = new CriticalFieldDetectionService(llmClient, redisClient);
 * const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');
 *
 * // Without LLM — returns empty result, no error
 * const service = new CriticalFieldDetectionService(null, redisClient);
 * const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');
 * // result = { totalFields: 0, criticalFields: [], reasoning: [] }
 * ```
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('critical-field-detection');

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_PREFIX = 'critical-field-detection:';
const CACHE_TTL_SECONDS = 60 * 60 * 6; // 6 hours
const MAX_RETRIES = 2;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Developer-Provided Examples Per Connector Type
 *
 * PATTERN: Few-shot learning with domain examples
 */
export interface ConnectorCriticalFieldExamples {
  connectorType: 'jira' | 'salesforce' | 'servicenow' | 'confluence' | 'hubspot' | 'googledrive';
  domain: string;
  exampleCriticalFields: Array<{
    fieldName: string;
    reasoning: string;
    category: 'identifier' | 'workflow' | 'classification' | 'temporal' | 'relationship';
    typicallyUsedFor: ('display' | 'filter' | 'aggregate')[];
  }>;
  criticalFieldPatterns: Array<{
    category: string;
    patterns: string[];
    reasoning: string;
  }>;
}

export interface CriticalField {
  fieldName: string;
  category: string;
  reasoning: string;
  confidence: number;
  usedFor: string[];
}

export interface CriticalFieldResult {
  totalFields: number;
  criticalFields: CriticalField[];
  reasoning: Array<{ field: string; reasoning: string }>;
}

interface DiscoveredField {
  path: string;
  type: string;
  label?: string;
  enumValues?: string[];
  sampleValues?: string[];
}

// ─── Developer-Provided Examples ─────────────────────────────────────────────

export const JIRA_CRITICAL_FIELDS_EXAMPLES: ConnectorCriticalFieldExamples = {
  connectorType: 'jira',
  domain: 'Project Management / Issue Tracking',
  exampleCriticalFields: [
    {
      fieldName: 'summary',
      reasoning: 'Primary identifier - every query needs issue title',
      category: 'identifier',
      typicallyUsedFor: ['display'],
    },
    {
      fieldName: 'status',
      reasoning: 'Workflow state - most common filter and grouping dimension',
      category: 'workflow',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'priority',
      reasoning: 'Urgency indicator - critical for filtering and prioritization',
      category: 'classification',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'assignee',
      reasoning: 'Ownership - essential for filtering by responsible person',
      category: 'relationship',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'created',
      reasoning: 'Temporal context - used for time-based filtering and trends',
      category: 'temporal',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'issueType',
      reasoning: 'Issue classification - critical for categorizing work items',
      category: 'classification',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
  ],
  criticalFieldPatterns: [
    {
      category: 'identifier',
      patterns: ['title', 'name', 'summary', 'subject', 'id', 'key'],
      reasoning: 'Fields that identify individual records',
    },
    {
      category: 'workflow',
      patterns: ['status', 'state', 'stage', 'phase'],
      reasoning: 'Fields that indicate process state',
    },
    {
      category: 'classification',
      patterns: ['type', 'category', 'priority', 'severity', 'tag', 'label'],
      reasoning: 'Fields that categorize records',
    },
    {
      category: 'temporal',
      patterns: ['created', 'updated', 'due', 'closed', 'resolved', 'date'],
      reasoning: 'Fields that track time information',
    },
    {
      category: 'relationship',
      patterns: ['assignee', 'owner', 'reporter', 'creator', 'team', 'project'],
      reasoning: 'Fields that link to people or groups',
    },
  ],
};

export const SALESFORCE_CRITICAL_FIELDS_EXAMPLES: ConnectorCriticalFieldExamples = {
  connectorType: 'salesforce',
  domain: 'CRM / Sales & Marketing',
  exampleCriticalFields: [
    {
      fieldName: 'Name',
      reasoning: 'Primary identifier for accounts, contacts, opportunities',
      category: 'identifier',
      typicallyUsedFor: ['display'],
    },
    {
      fieldName: 'Status',
      reasoning: 'Deal stage or record status - essential for pipeline analysis',
      category: 'workflow',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'Owner',
      reasoning: 'Sales rep assignment - critical for territory and quota tracking',
      category: 'relationship',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'Amount',
      reasoning: 'Deal value - fundamental for revenue reporting',
      category: 'classification',
      typicallyUsedFor: ['aggregate'],
    },
    {
      fieldName: 'CloseDate',
      reasoning: 'Expected close - essential for forecasting and pipeline management',
      category: 'temporal',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
  ],
  criticalFieldPatterns: [
    {
      category: 'identifier',
      patterns: ['Name', 'Title', 'Subject', 'Id'],
      reasoning: 'Fields that identify records in Salesforce',
    },
    {
      category: 'workflow',
      patterns: ['Status', 'Stage', 'StageName', 'IsClosed', 'IsWon'],
      reasoning: 'Fields that track sales process state',
    },
    {
      category: 'classification',
      patterns: ['Type', 'RecordType', 'Priority', 'Industry', 'LeadSource'],
      reasoning: 'Fields that categorize Salesforce records',
    },
    {
      category: 'temporal',
      patterns: ['CreatedDate', 'CloseDate', 'LastModifiedDate', 'ActivityDate'],
      reasoning: 'Date fields for time-based analysis',
    },
    {
      category: 'relationship',
      patterns: ['Owner', 'CreatedBy', 'Account', 'Contact', 'Lead'],
      reasoning: 'Relationship fields linking records',
    },
  ],
};

export const SERVICENOW_CRITICAL_FIELDS_EXAMPLES: ConnectorCriticalFieldExamples = {
  connectorType: 'servicenow',
  domain: 'IT Service Management / Ticketing',
  exampleCriticalFields: [
    {
      fieldName: 'number',
      reasoning: 'Ticket identifier - unique reference for all tickets',
      category: 'identifier',
      typicallyUsedFor: ['display'],
    },
    {
      fieldName: 'state',
      reasoning: 'Ticket lifecycle state - essential for workflow tracking',
      category: 'workflow',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'priority',
      reasoning: 'Urgency/impact combination - critical for SLA management',
      category: 'classification',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'assigned_to',
      reasoning: 'Current ticket owner - key for workload distribution',
      category: 'relationship',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
    {
      fieldName: 'opened_at',
      reasoning: 'Ticket creation time - fundamental for aging and SLA tracking',
      category: 'temporal',
      typicallyUsedFor: ['filter', 'aggregate'],
    },
  ],
  criticalFieldPatterns: [
    {
      category: 'identifier',
      patterns: ['number', 'sys_id', 'short_description'],
      reasoning: 'Ticket identification fields',
    },
    {
      category: 'workflow',
      patterns: ['state', 'work_state', 'incident_state', 'stage'],
      reasoning: 'ITSM workflow state fields',
    },
    {
      category: 'classification',
      patterns: ['priority', 'urgency', 'impact', 'category', 'subcategory'],
      reasoning: 'Ticket categorization and prioritization',
    },
    {
      category: 'temporal',
      patterns: ['opened_at', 'closed_at', 'resolved_at', 'sys_created_on', 'due_date'],
      reasoning: 'Time tracking for SLA management',
    },
    {
      category: 'relationship',
      patterns: ['assigned_to', 'caller_id', 'opened_by', 'assignment_group'],
      reasoning: 'User and team relationships',
    },
  ],
};

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Critical Field Detection Service
 *
 * Uses LLM analysis with developer-provided examples to identify
 * 10-20 critical fields per project.
 */
export class CriticalFieldDetectionService {
  private llmClient: WorkerLLMClient | null;
  private redis: RedisClient | null;
  private examplesRegistry: Map<string, ConnectorCriticalFieldExamples>;

  constructor(llmClient: WorkerLLMClient | null, redisClient?: RedisClient) {
    this.llmClient = llmClient;
    this.redis = redisClient || null;

    // Load developer-provided examples
    this.examplesRegistry = new Map([
      ['jira', JIRA_CRITICAL_FIELDS_EXAMPLES],
      ['salesforce', SALESFORCE_CRITICAL_FIELDS_EXAMPLES],
      ['servicenow', SERVICENOW_CRITICAL_FIELDS_EXAMPLES],
    ]);

    logger.info('CriticalFieldDetectionService initialized', {
      supportedConnectors: Array.from(this.examplesRegistry.keys()),
      caching: !!this.redis,
      llmAvailable: !!this.llmClient,
    });
  }

  /**
   * Detect critical fields using LLM analysis (FR-3)
   *
   * @param projectKbId - Project knowledge base ID
   * @param tenantId - Tenant ID for isolation
   * @param connectorType - Connector type (jira, salesforce, etc.)
   * @returns Critical fields with reasoning
   */
  async detectCriticalFields(
    projectKbId: string,
    tenantId: string,
    connectorType: string,
  ): Promise<CriticalFieldResult> {
    logger.info('Starting critical field detection', { projectKbId, tenantId, connectorType });

    // If no LLM client available, return empty result (graceful degradation)
    if (!this.llmClient) {
      logger.warn(
        'No LLM configured for critical field detection — skipping. Configure LLM credentials in Model Library.',
        { projectKbId, tenantId, connectorType },
      );
      return { totalFields: 0, criticalFields: [], reasoning: [] };
    }

    // Check cache
    if (this.redis) {
      const cached = await this.getCached(projectKbId, tenantId);
      if (cached) {
        logger.info('Returning cached critical fields', { projectKbId });
        return cached;
      }
    }

    const result: CriticalFieldResult = {
      totalFields: 0,
      criticalFields: [],
      reasoning: [],
    };

    try {
      // 1. Get developer-provided examples for this connector type
      const examples = this.examplesRegistry.get(connectorType);
      if (!examples) {
        throw new Error(`No critical field examples for connector type: ${connectorType}`);
      }

      // 2. Load discovered schema from existing service
      const discoveredSchema = await this.loadDiscoveredSchema(projectKbId, tenantId);
      result.totalFields = discoveredSchema.length;

      if (discoveredSchema.length === 0) {
        logger.warn('No fields in discovered schema', { projectKbId });
        return result;
      }

      // 3. Scrub PII from sample values (placeholder for now)
      const scrubbedSchema = this.scrubPII(discoveredSchema);

      // 4. Build LLM prompt with schema + examples
      const systemPrompt = this.buildCriticalFieldPrompt(scrubbedSchema, examples);

      // 5. Call LLM to identify critical fields (with retry)
      const criticalFields = await this.callLLMWithRetry(systemPrompt);

      result.criticalFields = criticalFields;
      result.reasoning = criticalFields.map((f) => ({
        field: f.fieldName,
        reasoning: f.reasoning,
      }));

      // 6. Cache result
      if (this.redis) {
        await this.setCached(projectKbId, tenantId, result);
      }

      logger.info('Critical fields detected', {
        projectKbId,
        totalFields: result.totalFields,
        criticalCount: result.criticalFields.length,
      });

      return result;
    } catch (error) {
      logger.error('Critical field detection failed — returning empty result', {
        error: error instanceof Error ? error.message : String(error),
        projectKbId,
        tenantId,
        connectorType,
      });
      return { totalFields: 0, criticalFields: [], reasoning: [] };
    }
  }

  /**
   * Build LLM prompt with schema injection + few-shot examples
   */
  private buildCriticalFieldPrompt(
    discoveredSchema: DiscoveredField[],
    examples: ConnectorCriticalFieldExamples,
  ): string {
    // Format discovered schema
    const schemaDesc = discoveredSchema
      .map((field) => {
        let desc = `- ${field.path}: ${field.type}`;
        if (field.label) desc += ` ("${field.label}")`;
        if (field.enumValues && field.enumValues.length > 0) {
          desc += ` enum [${field.enumValues.slice(0, 3).join(', ')}${field.enumValues.length > 3 ? ', ...' : ''}]`;
        }
        return desc;
      })
      .join('\n');

    // Format example critical fields
    const examplesDesc = examples.exampleCriticalFields
      .map(
        (ex) =>
          `- ${ex.fieldName}
  Category: ${ex.category}
  Reasoning: ${ex.reasoning}
  Typically used for: ${ex.typicallyUsedFor.join(', ')}`,
      )
      .join('\n\n');

    // Format patterns
    const patternsDesc = examples.criticalFieldPatterns
      .map(
        (pattern) =>
          `- ${pattern.category}: ${pattern.patterns.join(', ')}
  ${pattern.reasoning}`,
      )
      .join('\n\n');

    return `You are a critical field detector for ${examples.domain} systems. Given a discovered schema, identify the 10-20 most critical fields that should have vocabulary entries auto-generated.

## Domain: ${examples.domain}

## Example Critical Fields from Similar Projects

${examplesDesc}

## Critical Field Patterns

${patternsDesc}

## Discovered Schema for THIS Project

${schemaDesc}

## Selection Criteria

A field is critical if it meets ANY of these criteria:

1. **Identifier** - Uniquely identifies records (title, name, ID)
2. **High Query Frequency** - Likely to be used in most queries
3. **Filtering Essential** - Common dimension for narrowing results
4. **Aggregation Key** - Used for grouping/counting (status, type, category)
5. **Temporal Context** - Time-based filtering (created, updated, due dates)
6. **Relationship Key** - Links to people/teams (assignee, owner, creator)

## Output Format

Return JSON array of 10-20 critical fields:

\`\`\`json
[
  {
    "fieldName": "summary",
    "category": "identifier",
    "reasoning": "Primary identifier for issues, used in all result displays",
    "confidence": 0.98,
    "usedFor": ["display"]
  }
]
\`\`\`

IMPORTANT:
- Different projects may have different critical fields even with same connector
- Consider field names, types, and domain patterns
- Limit to 10-20 fields (don't include all fields)
- Provide clear reasoning for each selection`;
  }

  /**
   * Call LLM with retry logic for malformed responses
   */
  private async callLLMWithRetry(systemPrompt: string): Promise<CriticalField[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const llmResponse = await this.llmClient!.chat(
          systemPrompt,
          [{ role: 'user', content: 'Identify the 10-20 most critical fields for this project.' }],
          {
            maxTokens: 2000,
          },
        );

        // Parse response
        const criticalFields = this.parseCriticalFieldsResponse(llmResponse);

        if (criticalFields.length > 0) {
          return criticalFields;
        }

        throw new Error('LLM returned empty critical fields array');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn('LLM call failed, retrying', {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          error: lastError.message,
        });

        if (attempt < MAX_RETRIES) {
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    logger.error('All LLM retries exhausted for critical field detection', {
      maxRetries: MAX_RETRIES,
      lastError: lastError?.message,
    });
    return [];
  }

  /**
   * Parse LLM response and extract critical fields
   */
  private parseCriticalFieldsResponse(llmResponse: string): CriticalField[] {
    try {
      // Extract JSON array from response (handle markdown code fences)
      const jsonMatch =
        llmResponse.match(/```json\n([\s\S]*?)\n```/) || llmResponse.match(/\[[\s\S]*\]/);

      if (!jsonMatch) {
        throw new Error('No JSON array found in LLM response');
      }

      const jsonText = jsonMatch[1] || jsonMatch[0];
      const fields = JSON.parse(jsonText) as Array<{
        fieldName: string;
        category: string;
        reasoning: string;
        confidence?: number;
        usedFor?: string[];
      }>;

      return fields.map((field) => ({
        fieldName: field.fieldName,
        category: field.category,
        reasoning: field.reasoning,
        confidence: field.confidence || 0.9,
        usedFor: field.usedFor || ['display', 'filter'],
      }));
    } catch (error) {
      logger.error('Failed to parse critical fields response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Load discovered schema from existing service
   *
   * TODO: Import from existing schema-discovery service
   * For now, returns stub for testing
   */
  private async loadDiscoveredSchema(
    _projectKbId: string,
    _tenantId: string,
  ): Promise<DiscoveredField[]> {
    // TODO: Integrate with existing schema-discovery service
    // This will be replaced when schema-discovery is integrated
    return [];
  }

  /**
   * Scrub PII from sample values
   *
   * TODO: Integrate with PIIScrubber service (Task 4.1)
   * For now, returns placeholder implementation
   */
  private scrubPII(schema: DiscoveredField[]): DiscoveredField[] {
    // TODO: Implement PII scrubbing after PIIScrubber service is available
    // For now, just remove sample values as a safety measure
    return schema.map((field) => ({
      ...field,
      sampleValues: undefined, // Remove sample values until PIIScrubber is integrated
    }));
  }

  /**
   * Get cached critical fields
   */
  private async getCached(
    projectKbId: string,
    tenantId: string,
  ): Promise<CriticalFieldResult | null> {
    if (!this.redis) return null;

    try {
      const key = this.getCacheKey(projectKbId, tenantId);
      const cached = await this.redis.get(key);

      if (!cached) return null;

      return JSON.parse(cached) as CriticalFieldResult;
    } catch (error) {
      logger.warn('Failed to get cached critical fields', {
        error: error instanceof Error ? error.message : String(error),
        projectKbId,
      });
      return null;
    }
  }

  /**
   * Cache critical fields result
   */
  private async setCached(
    projectKbId: string,
    tenantId: string,
    result: CriticalFieldResult,
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const key = this.getCacheKey(projectKbId, tenantId);
      await this.redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(result));
    } catch (error) {
      logger.warn('Failed to cache critical fields', {
        error: error instanceof Error ? error.message : String(error),
        projectKbId,
      });
    }
  }

  /**
   * Generate cache key
   */
  private getCacheKey(projectKbId: string, tenantId: string): string {
    return `${CACHE_PREFIX}${tenantId}:${projectKbId}`;
  }

  /**
   * Clear cache for specific project (useful after schema changes)
   */
  async clearCache(projectKbId: string, tenantId: string): Promise<void> {
    if (!this.redis) return;

    try {
      const key = this.getCacheKey(projectKbId, tenantId);
      await this.redis.del(key);
      logger.info('Cleared critical fields cache', { projectKbId });
    } catch (error) {
      logger.warn('Failed to clear cache', {
        error: error instanceof Error ? error.message : String(error),
        projectKbId,
      });
    }
  }
}
