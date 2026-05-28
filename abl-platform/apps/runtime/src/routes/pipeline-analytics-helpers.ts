/**
 * Pure helpers extracted from pipeline-analytics route for testability.
 */

export const VALID_PIPELINE_TYPES = new Set([
  'sentiment_analysis',
  'intent_classification',
  'quality_evaluation',
  'hallucination_detection',
  'knowledge_gap',
  'guardrail_analysis',
  'context_preservation',
  'friction_detection',
  'anomaly_detection',
  'drift_detection',
  'llm_evaluate',
]);

/**
 * SECURITY: These table/column names are interpolated directly into SQL.
 * They are safe because they are hardcoded constants — never derived from user input.
 * Do NOT add dynamic values here. If you need to add a new pipeline type,
 * add it to VALID_PIPELINE_TYPES first, then add its table mapping here.
 * All user-derived values (days, limit, offset, filter values) MUST use
 * ClickHouse parameterized queries ({name:Type}).
 */
export const PIPELINE_TABLES: Record<string, string> = {
  sentiment_analysis: 'abl_platform.conversation_sentiment',
  intent_classification: 'abl_platform.intent_classifications',
  quality_evaluation: 'abl_platform.quality_evaluations',
  hallucination_detection: 'abl_platform.hallucination_evaluations',
  knowledge_gap: 'abl_platform.knowledge_gap_evaluations',
  guardrail_analysis: 'abl_platform.guardrail_evaluations',
  context_preservation: 'abl_platform.context_evaluations',
  friction_detection: 'abl_platform.friction_detections',
  anomaly_detection: 'abl_platform.anomaly_detections',
  drift_detection: 'abl_platform.drift_detections',
  llm_evaluate: 'abl_platform.llm_evaluate',
};

export const PIPELINE_MV_TABLES: Record<string, string> = {
  sentiment_analysis: 'abl_platform.mv_daily_sentiment',
  intent_classification: 'abl_platform.mv_daily_intent_distribution',
  quality_evaluation: 'abl_platform.mv_daily_quality_scores',
  llm_evaluate: 'abl_platform.mv_daily_llm_evaluate',
};

export const PIPELINE_DATE_COLUMNS: Record<string, string> = {
  sentiment_analysis: 'session_started_at',
  intent_classification: 'session_started_at',
  quality_evaluation: 'session_started_at',
  hallucination_detection: 'session_started_at',
  knowledge_gap: 'session_started_at',
  guardrail_analysis: 'session_started_at',
  context_preservation: 'session_started_at',
  friction_detection: 'session_started_at',
  anomaly_detection: 'processed_at',
  drift_detection: 'processed_at',
  llm_evaluate: 'processed_at',
};

export const GUARDRAIL_FAILURE_PREDICATE =
  '(flagged = 1 OR false_positive_score > 0.5 OR false_negative_score > 0.5 OR bypass_detected = 1)';

export const SESSION_DEDUPED_PIPELINE_TYPES = new Set([
  'sentiment_analysis',
  'intent_classification',
  'quality_evaluation',
]);

export const SESSION_EVALUATION_PIPELINE_TYPES = new Set([
  'quality_evaluation',
  'hallucination_detection',
  'knowledge_gap',
  'guardrail_analysis',
  'context_preservation',
]);

const SESSION_DEDUPED_PIPELINE_COLUMNS: Record<string, string[]> = {
  sentiment_analysis: [
    'session_started_at',
    'agent_name',
    'channel',
    'avg_sentiment',
    'start_sentiment',
    'end_sentiment',
    'sentiment_trajectory',
    'frustration_detected',
    'frustration_turn_count',
  ],
  intent_classification: [
    'session_started_at',
    'agent_name',
    'channel',
    'intent',
    'intent_display',
    'confidence',
    'resolution_status',
  ],
  quality_evaluation: [
    'session_started_at',
    'agent_name',
    'channel',
    'overall_score',
    'helpfulness',
    'accuracy',
    'professionalism',
    'instruction_following',
    'custom_dimensions',
    'flagged',
    'flag_reasons',
  ],
};

export function shouldDedupePipelineBySession(pipelineType: string): boolean {
  return SESSION_DEDUPED_PIPELINE_TYPES.has(pipelineType);
}

export function buildLatestPipelineRowsSubquery(
  pipelineType: string,
  table: string,
  dateCol: string,
  offsetDays = 0,
): string {
  const columns = SESSION_DEDUPED_PIPELINE_COLUMNS[pipelineType];
  if (!columns) {
    return pipelineTableExpression(pipelineType, table);
  }

  // Use a temporary alias for the date column in the inner query to avoid
  // ClickHouse ILLEGAL_AGGREGATION: argMax(col) AS col shadows the column name
  // in the WHERE clause when alias and column share the same name.
  const innerAlias = (col: string) => (col === dateCol ? `_${col}` : col);
  const projections = columns.map(
    (column) => `argMax(${column}, processed_at) AS ${innerAlias(column)}`,
  );
  // Outer SELECT remaps _<dateCol> back to <dateCol> so all consumers are unchanged.
  const outerColumns = [
    'session_id',
    ...columns.map((col) => (col === dateCol ? `_${col} AS ${col}` : col)),
  ];
  const datePredicate = dateWindowPredicate(dateCol, offsetDays);
  const sourcePredicate = pipelineSourcePredicate(pipelineType);
  const tableExpression = pipelineTableExpression(pipelineType, table);

  return `
    (
      SELECT
        ${outerColumns.join(',\n        ')}
      FROM (
        SELECT
          session_id,
          ${projections.join(',\n          ')}
        FROM ${tableExpression}
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND ${datePredicate}
          ${sourcePredicate}
        GROUP BY session_id
      )
    )
  `;
}

const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 90;

/** Parse period string (7d, 30d, etc.) to a bounded day count. Defaults to 7. */
export function periodToDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  if (!match) return DEFAULT_PERIOD_DAYS;
  const days = parseInt(match[1], 10);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_PERIOD_DAYS;
  return Math.min(days, MAX_PERIOD_DAYS);
}

/** Parse offsetDays for previous-window comparisons. Invalid values default to current window. */
export function parseOffsetDays(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export function dateWindowQueryParams(days: number, offsetDays: number) {
  return {
    days,
    offsetDays,
    windowStartDays: days + offsetDays,
  };
}

export function dateWindowPredicate(dateCol: string, offsetDays: number): string {
  if (offsetDays > 0) {
    return `${dateCol} >= now() - INTERVAL {windowStartDays:UInt32} DAY
        AND ${dateCol} < now() - INTERVAL {offsetDays:UInt32} DAY`;
  }
  return `${dateCol} >= now() - INTERVAL {windowStartDays:UInt32} DAY`;
}

export function pipelineTableExpression(pipelineType: string, table: string): string {
  return SESSION_EVALUATION_PIPELINE_TYPES.has(pipelineType) ? `${table} FINAL` : table;
}

export function isSessionEvaluationPipeline(pipelineType: string): boolean {
  return SESSION_EVALUATION_PIPELINE_TYPES.has(pipelineType);
}

export function pipelineSourcePredicate(pipelineType: string): string {
  return SESSION_EVALUATION_PIPELINE_TYPES.has(pipelineType)
    ? "AND (source = 'batch' OR source = '')"
    : '';
}

export function validatePipelineType(pipelineType: string): boolean {
  return VALID_PIPELINE_TYPES.has(pipelineType);
}

/**
 * Normalize a ClickHouse JSON response to an array of rows.
 *
 * The ClickHouse client may return:
 *   A) A plain array of rows
 *   B) An object with a `data` array (raw ClickHouse JSON format with meta)
 *
 * This helper handles both shapes consistently.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseClickHouseRows(jsonResult: any): Record<string, unknown>[] {
  if (Array.isArray(jsonResult)) return jsonResult;
  return jsonResult?.data ?? [];
}
