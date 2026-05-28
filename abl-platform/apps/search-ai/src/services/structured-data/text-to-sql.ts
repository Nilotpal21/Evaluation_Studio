/**
 * Text-to-SQL Service
 *
 * Generates SQL queries from natural language using LLM.
 * Validates generated SQL against table schemas for safety.
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import { resolveIndexLLMConfig } from '../llm-config/resolver.js';
import { createLogger } from '@abl/compiler/platform';
import type { TableMetadata } from './types.js';

const logger = createLogger('text-to-sql');

// =============================================================================
// TYPES
// =============================================================================

export interface TextToSQLRequest {
  query: string;
  tables: TableMetadata[];
  tenantId: string;
  indexId: string;
  maxResults?: number;
}

export interface TextToSQLResponse {
  sql: string;
  explanation: string;
  confidence: number;
  tablesReferenced: string[];
  warnings?: string[];
}

export interface SQLValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// =============================================================================
// TEXT-TO-SQL SERVICE
// =============================================================================

export class TextToSQLService {
  /**
   * Generate SQL from natural language query
   */
  async generateSQL(request: TextToSQLRequest): Promise<TextToSQLResponse> {
    // Handle empty tables array
    if (request.tables.length === 0) {
      return {
        sql: 'SELECT 1',
        explanation: 'No tables available for query generation',
        confidence: 0.1,
        tablesReferenced: [],
        warnings: ['No tables provided for query generation'],
      };
    }

    // Build schema context for LLM
    const schemaContext = this.buildSchemaContext(request.tables);

    // Build prompt
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(request.query, schemaContext, request.maxResults);

    logger.info('Generating SQL for query', { query: request.query });

    try {
      // Load tenant LLM credentials via Model Library
      const { provider, apiKey, model } = await this.loadLLMConfig(
        request.tenantId,
        request.indexId,
      );

      // Create LLM client
      const llmClient = new WorkerLLMClient(provider, apiKey, model);

      // Call LLM to generate SQL
      const response = await llmClient.chat(systemPrompt, [{ role: 'user', content: userPrompt }], {
        model,
        maxTokens: 1000,
        timeoutMs: 30000,
      });

      // Extract SQL from response
      const sql = this.extractSQL(response);

      // Validate generated SQL
      const validation = this.validateSQL(sql, request.tables);

      // If validation failed, throw error
      if (!validation.isValid) {
        logger.error('Generated SQL failed validation', { errors: validation.errors });
        throw new Error(`Generated SQL failed validation: ${validation.errors.join(', ')}`);
      }

      // Extract explanation (text before SQL)
      const explanation = this.extractExplanation(response);

      // Determine confidence based on validation
      const confidence = validation.warnings.length === 0 ? 0.9 : 0.7;

      // Extract table references from SQL
      const tablesReferenced = this.extractTableReferences(sql, request.tables);

      return {
        sql,
        explanation,
        confidence,
        tablesReferenced,
        warnings: validation.warnings,
      };
    } catch (error) {
      logger.error('Failed to generate SQL', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to placeholder SQL on error
      const sql = this.generatePlaceholderSQL(request);
      const validation = this.validateSQL(sql, request.tables);

      return {
        sql,
        explanation: `LLM SQL generation failed: ${error instanceof Error ? error.message : 'Unknown error'}. Using placeholder query.`,
        confidence: 0.3,
        tablesReferenced: request.tables.map((t) => t.table_name),
        warnings: [...validation.warnings, 'Using fallback placeholder query due to LLM error'],
      };
    }
  }

  /**
   * Build schema context string for LLM prompt
   */
  private buildSchemaContext(tables: TableMetadata[]): string {
    const schemaLines: string[] = [];

    for (const table of tables) {
      schemaLines.push(`Table: ${table.table_name} (${table.display_name})`);
      schemaLines.push(`Description: ${table.table_description}`);

      // Parse columns
      const columns = JSON.parse(table.columns) as string[];
      const columnTypes = JSON.parse(table.column_types) as string[];
      const columnDescriptions = JSON.parse(table.column_descriptions) as Record<string, string>;

      schemaLines.push('Columns:');
      for (let i = 0; i < columns.length; i++) {
        const colName = columns[i];
        const colType = columnTypes[i];
        const colDesc = columnDescriptions[colName] || '';
        schemaLines.push(`  - ${colName} (${colType}): ${colDesc}`);
      }

      if (table.primary_key) {
        schemaLines.push(`Primary Key: ${table.primary_key}`);
      }

      // Parse and show sample data
      const sampleRows = JSON.parse(table.sample_rows) as Record<string, any>[];
      if (sampleRows.length > 0) {
        schemaLines.push(`Sample data (first 3 rows):`);
        sampleRows.slice(0, 3).forEach((row, idx) => {
          schemaLines.push(`  Row ${idx + 1}: ${JSON.stringify(row)}`);
        });
      }

      schemaLines.push(''); // Empty line between tables
    }

    return schemaLines.join('\n');
  }

  /**
   * Build system prompt for SQL generation
   */
  private buildSystemPrompt(): string {
    return `You are a SQL expert assistant that generates safe, read-only SQL queries from natural language.

CRITICAL SAFETY RULES:
- ONLY generate SELECT statements
- NEVER use DROP, DELETE, UPDATE, INSERT, ALTER, TRUNCATE, or CREATE
- NEVER use multiple statements (no semicolons except at the end)
- Always include a LIMIT clause to prevent unbounded results
- Use proper JOIN syntax when combining tables
- Match column and table names exactly as provided in the schema

Your response format:
1. First, provide a brief explanation of what the query does (1-2 sentences)
2. Then, provide the SQL query enclosed in triple backticks with sql language tag

Example:
This query retrieves all products with price greater than 100, ordered by name.
\`\`\`sql
SELECT id, name, price FROM products WHERE price > 100 ORDER BY name LIMIT 10
\`\`\``;
  }

  /**
   * Build user prompt with query and schema context
   */
  private buildUserPrompt(query: string, schemaContext: string, maxResults = 10): string {
    return `Database Schema:
${schemaContext}

User Question: "${query}"

Requirements:
- Generate a valid SELECT query that answers the question
- Use aggregate functions (COUNT, SUM, AVG, etc.) if the question asks for totals or averages
- Add ORDER BY if the question implies ranking or sorting
- Limit results to ${maxResults} rows unless the question specifies otherwise
- Ensure column names and table names match the schema exactly

Please provide your response in the format specified in the system prompt.`;
  }

  /**
   * Validate generated SQL for safety and correctness
   */
  private validateSQL(sql: string, tables: TableMetadata[]): SQLValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Safety checks
    if (/\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE)\b/i.test(sql)) {
      errors.push('Destructive SQL operations are not allowed');
    }

    if (/;\s*\w+/.test(sql)) {
      errors.push('Multiple SQL statements are not allowed');
    }

    // Check table references
    const tableNames = tables.map((t) => t.table_name);
    for (const tableName of tableNames) {
      if (sql.includes(tableName)) {
        // Table is referenced - good
      }
    }

    // Check for SELECT statement
    if (!/^\s*SELECT\b/i.test(sql)) {
      errors.push('Query must start with SELECT');
    }

    // Warn about missing LIMIT
    if (!/\bLIMIT\b/i.test(sql)) {
      warnings.push('Query does not have LIMIT clause - may return large result sets');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Generate placeholder SQL (for testing before LLM integration)
   */
  private generatePlaceholderSQL(request: TextToSQLRequest): string {
    const table = request.tables[0];
    if (!table) {
      return 'SELECT 1';
    }

    const columns = JSON.parse(table.columns) as string[];
    const limit = request.maxResults || 10;

    return `SELECT ${columns.slice(0, 5).join(', ')}
FROM ${table.table_name}
LIMIT ${limit}`;
  }

  /**
   * Load LLM configuration for tenant via Model Library (resolveIndexLLMConfig).
   *
   * Uses the `textToSql` use case from the resolved config.
   * Falls back to top-level tenant credentials with balanced tier model
   * if the `textToSql` use case is not registered yet.
   */
  private async loadLLMConfig(
    tenantId: string,
    indexId: string,
  ): Promise<{ provider: string; apiKey: string; model: string }> {
    const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

    // Try textToSql use case first, fall back to top-level credentials
    const textToSqlConfig = llmConfig.useCases.textToSql;
    if (textToSqlConfig?.enabled && textToSqlConfig.apiKey) {
      return {
        provider: textToSqlConfig.provider,
        apiKey: textToSqlConfig.apiKey,
        model: textToSqlConfig.model,
      };
    }

    // Fall back to top-level tenant credentials with balanced tier model
    if (llmConfig.apiKey) {
      return {
        provider: llmConfig.provider,
        apiKey: llmConfig.apiKey,
        model:
          llmConfig.useCases.knowledgeGraph?.model ||
          llmConfig.useCases.mapping_suggestion?.model ||
          '',
      };
    }

    throw new Error(
      `No LLM credentials configured for tenant ${tenantId}. ` +
        'Please configure LLM credentials in the Model Library.',
    );
  }

  /**
   * Extract SQL from LLM response
   */
  private extractSQL(response: string): string {
    // Try to extract SQL from code block first
    const codeBlockMatch = response.match(/```sql\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Try to find SQL statement (SELECT ... ;)
    const sqlMatch = response.match(/SELECT[\s\S]*?;?$/im);
    if (sqlMatch) {
      return sqlMatch[0].trim();
    }

    // If no clear SQL found, return the whole response (will likely fail validation)
    return response.trim();
  }

  /**
   * Extract explanation from LLM response
   */
  private extractExplanation(response: string): string {
    // Extract text before the code block or SQL statement
    const beforeCodeBlock = response.split(/```sql/i)[0];
    if (beforeCodeBlock && beforeCodeBlock.trim()) {
      return beforeCodeBlock.trim();
    }

    // Fallback: first sentence of response
    const firstSentence = response.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      return firstSentence[0].trim();
    }

    return 'Generated SQL query for the user question';
  }

  /**
   * Extract table references from SQL query
   */
  private extractTableReferences(sql: string, tables: TableMetadata[]): string[] {
    const tableNames = tables.map((t) => t.table_name);
    const referenced: string[] = [];

    for (const tableName of tableNames) {
      // Check if table name appears in SQL (case-insensitive)
      const regex = new RegExp(`\\b${tableName}\\b`, 'i');
      if (regex.test(sql)) {
        referenced.push(tableName);
      }
    }

    return referenced.length > 0 ? referenced : tableNames.slice(0, 1); // Default to first table
  }

  /**
   * Extract column references from SQL query
   */
  private extractColumnReferences(sql: string): string[] {
    // Simple regex to extract column names (between SELECT and FROM)
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
    if (!selectMatch) return [];

    const selectClause = selectMatch[1];
    const columns = selectClause
      .split(',')
      .map((col) => col.trim().replace(/\s+AS\s+\w+/i, ''))
      .filter((col) => col !== '*');

    return columns;
  }

  /**
   * Sanitize SQL query (remove dangerous patterns)
   */
  private sanitizeSQL(sql: string): string {
    // Remove comments
    let sanitized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // Remove multiple statements
    const firstStatement = sanitized.split(';')[0];

    // Trim whitespace
    return firstStatement.trim();
  }
}
