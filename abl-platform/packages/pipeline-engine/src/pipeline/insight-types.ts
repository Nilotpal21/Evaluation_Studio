/**
 * Standardized types for insight compute handlers.
 *
 * Every compute handler returns an InsightResult. The store-insight activity
 * maps these fields to the ClickHouse insight_results table columns.
 */

export type Granularity = 'message' | 'span' | 'session' | 'agent' | 'project';
export type InsightStatus = 'pass' | 'warn' | 'fail';

/**
 * Output from a compute handler — a single aggregate result, optionally
 * with per-record detail rows.
 */
export interface InsightResult {
  /** Handler identifier, e.g. 'toxicity', 'tool-effectiveness' */
  insightType: string;

  /** Granularity of the result — maps to ClickHouse Enum8 column */
  granularity: Granularity;

  /** Normalized score (0.0–1.0) */
  score: number;

  /** Overall pass/warn/fail status */
  status: InsightStatus;

  /** Handler-specific payload — stored as JSON string in ClickHouse dimensions column */
  dimensions: Record<string, unknown>;

  /**
   * Optional batch records — each becomes a separate ClickHouse row.
   * If omitted, a single row is written using the top-level fields.
   */
  records?: InsightRecord[];
}

/**
 * A single detail row within a batch InsightResult.
 * Each record becomes one row in the insight_results table.
 */
export interface InsightRecord {
  sessionId?: string;
  messageId?: string;
  spanId?: string;
  agentName?: string;
  score: number;
  status: InsightStatus;
  dimensions: Record<string, unknown>;
  eventTimestamp?: string;
}
