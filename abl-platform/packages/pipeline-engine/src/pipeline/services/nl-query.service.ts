/**
 * NL-to-SQL Query Service — translates natural language questions into
 * ClickHouse SQL queries, validates them for safety, executes them, and
 * returns structured results.
 *
 * Security:
 *   - Only SELECT queries are allowed
 *   - All queries must include a tenant_id filter for data isolation
 *   - Forbidden operations (INSERT, UPDATE, DELETE, DROP, etc.) are rejected
 *   - Query execution has a 30-second timeout
 */
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import { getSemanticLayerPrompt } from './semantic-layer.js';

const log = createLogger('nl-query');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE)\b/i,
  /\bINTO\b/i,
  /\bSYSTEM\b/i,
  /\bATTACH\b/i,
  /\bDETACH\b/i,
];

const REQUIRED_FILTER = /tenant_id\s*=\s*/i;

const MAX_EXECUTION_TIME = 30;
const MAX_RESULT_ROWS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NLQueryResult {
  question: string;
  sql: string;
  data: Record<string, unknown>[];
  rowCount: number;
}

// ---------------------------------------------------------------------------
// SQL Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a SQL query is safe to execute.
 * Returns null if valid, or an error message if invalid.
 */
export function validateSQL(sql: string): string | null {
  // Must be a SELECT query
  if (!/^\s*SELECT\b/i.test(sql)) {
    return 'Only SELECT queries are allowed';
  }

  // Check for forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(sql)) {
      return `Forbidden SQL operation detected: ${pattern.source}`;
    }
  }

  // Must include tenant_id filter
  if (!REQUIRED_FILTER.test(sql)) {
    return 'Query must include a tenant_id filter for data isolation';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class NLQueryService {
  /**
   * Execute a natural language query against ClickHouse analytics tables.
   *
   * 1. Generates SQL from the question using the semantic layer as LLM context
   * 2. Validates the generated SQL for safety
   * 3. Executes the query with a timeout
   * 4. Returns structured results
   */
  async executeQuery(
    tenantId: string,
    projectId: string,
    question: string,
  ): Promise<NLQueryResult> {
    // Get semantic layer context
    const schemaContext = getSemanticLayerPrompt();

    // Generate SQL via LLM
    const resolved = await resolvePipelineLLM(tenantId, projectId);
    const response = await pipelineGenerateText(
      resolved,
      {
        system: `You are a SQL expert. Generate a ClickHouse SQL query to answer the user's question.

RULES:
- Only SELECT queries are allowed
- ALWAYS filter by tenant_id = '${tenantId}' AND project_id = '${projectId}'
- Use proper ClickHouse syntax
- Return ONLY the SQL query, no explanation
- Limit results to ${MAX_RESULT_ROWS} rows maximum
- Use the tables described below

${schemaContext}`,
        messages: [
          {
            role: 'user' as const,
            content: `tenant_id: ${tenantId}\nproject_id: ${projectId}\n\nQuestion: ${question}`,
          },
        ],
        temperature: 0,
      },
      { service: 'nl-query', tenantId, projectId },
    );

    // Extract SQL from response — strip markdown code blocks if present
    let sql = response.content.trim();
    sql = sql
      .replace(/^```(?:sql)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    // Validate SQL
    const validationError = validateSQL(sql);
    if (validationError) {
      throw new Error(`SQL validation failed: ${validationError}`);
    }

    // Execute query with timeout
    const ch = getClickHouseClient();
    const result = await ch.query({
      query: sql,
      query_params: { tenantId, projectId },
      clickhouse_settings: {
        max_execution_time: MAX_EXECUTION_TIME,
      },
    });

    const data = ((await result.json()) as { data: Record<string, unknown>[] }).data;

    log.info('NL query executed', {
      tenantId,
      projectId,
      question,
      sql,
      rowCount: data.length,
    });

    return {
      question,
      sql,
      data,
      rowCount: data.length,
    };
  }
}
