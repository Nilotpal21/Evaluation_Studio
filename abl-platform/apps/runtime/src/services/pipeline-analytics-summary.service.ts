/**
 * Pipeline Analytics Summary Service
 *
 * Extracted from pipeline-analytics.ts to share with governance status fan-out.
 *
 * buildSummaryQuery — pure function, returns the SQL string for a pipeline type
 * executePipelineSummary — wraps buildSummaryQuery + ClickHouse query execution
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  dateWindowPredicate,
  dateWindowQueryParams,
  PIPELINE_TABLES,
  PIPELINE_DATE_COLUMNS,
  buildLatestPipelineRowsSubquery,
  GUARDRAIL_FAILURE_PREDICATE,
  periodToDays,
  parseClickHouseRows,
  shouldDedupePipelineBySession,
  pipelineSourcePredicate,
  pipelineTableExpression,
} from '../routes/pipeline-analytics-helpers.js';

/**
 * Build a ClickHouse summary SQL query for the given pipeline type.
 *
 * Pure function — no I/O. The 11-branch switch maps each pipeline type
 * to its specific aggregate SELECT.
 *
 * @param pipelineType - one of the 11 VALID_PIPELINE_TYPES
 * @param table - ClickHouse table name (from PIPELINE_TABLES)
 * @param dateCol - date column name (from PIPELINE_DATE_COLUMNS)
 * @returns SQL query string with tenant/project/date-window placeholders
 */
export function buildSummaryQuery(
  pipelineType: string,
  table: string,
  dateCol: string,
  offsetDays = 0,
): string {
  const shouldDedupeBySession = shouldDedupePipelineBySession(pipelineType);
  const source = shouldDedupeBySession
    ? buildLatestPipelineRowsSubquery(pipelineType, table, dateCol, offsetDays)
    : pipelineTableExpression(pipelineType, table);
  const datePredicate = dateWindowPredicate(dateCol, offsetDays);
  const sourcePredicate = pipelineSourcePredicate(pipelineType);
  const sourceScope = shouldDedupeBySession
    ? ''
    : `
      WHERE tenant_id = {tenantId:String}
        AND project_id = {projectId:String}
        AND ${datePredicate}
        ${sourcePredicate}
    `;

  if (pipelineType === 'sentiment_analysis') {
    return `
      SELECT
        count() AS total_conversations,
        round(avg(avg_sentiment), 3) AS avg_sentiment,
        round(avg(start_sentiment), 3) AS avg_start_sentiment,
        round(avg(end_sentiment), 3) AS avg_end_sentiment,
        sum(CASE WHEN sentiment_trajectory = 'improving' THEN 1 ELSE 0 END) AS improving_count,
        sum(CASE WHEN sentiment_trajectory = 'declining' THEN 1 ELSE 0 END) AS declining_count,
        sum(CASE WHEN sentiment_trajectory = 'stable' THEN 1 ELSE 0 END) AS stable_count,
        sum(frustration_detected) AS frustrated_count,
        round(avg(frustration_turn_count), 2) AS avg_frustration_turns
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'intent_classification') {
    // Unique-session counts: same session can produce multiple rows (realtime
    // trigger fires per user message, batch fires at session end). Collapse to
    // the latest row per session before aggregating so stale replacement rows
    // cannot influence intent, confidence, or resolution metrics.
    return `
      SELECT
        count() AS total_conversations,
        uniqExact(intent) AS unique_intents,
        round(avg(confidence), 3) AS avg_confidence,
        topK(10)(intent) AS top_intents,
        countIf(resolution_status != '') AS evaluated_count,
        round(countIf(resolution_status = 'resolved') / nullif(countIf(resolution_status != ''), 0), 3) AS resolution_rate,
        round(countIf(resolution_status = 'partial') / nullif(countIf(resolution_status != ''), 0), 3) AS partial_rate
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'quality_evaluation') {
    return `
      SELECT
        count() AS total_conversations,
        round(avg(overall_score), 3) AS avg_overall_score,
        round(avg(helpfulness), 3) AS avg_helpfulness,
        round(avg(accuracy), 3) AS avg_accuracy,
        round(avg(professionalism), 3) AS avg_professionalism,
        round(avg(instruction_following), 3) AS avg_instruction_following,
        sum(flagged) AS flagged_count,
        round(sum(flagged) / nullif(count(), 0) * 100, 1) AS flagged_rate_pct,
        sumMap(
          arrayMap(kv -> tupleElement(kv, 1), if(custom_dimensions != '', JSONExtractKeysAndValues(custom_dimensions, 'Float64'), [])),
          arrayMap(kv -> tupleElement(kv, 2), if(custom_dimensions != '', JSONExtractKeysAndValues(custom_dimensions, 'Float64'), []))
        ) AS _custom_dim_sums,
        sumMap(
          arrayMap(kv -> tupleElement(kv, 1), if(custom_dimensions != '', JSONExtractKeysAndValues(custom_dimensions, 'Float64'), [])),
          arrayMap(kv -> toFloat64(1), if(custom_dimensions != '', JSONExtractKeysAndValues(custom_dimensions, 'Float64'), []))
        ) AS _custom_dim_counts
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'hallucination_detection') {
    return `
      SELECT
        count() AS total_evaluations,
        round(avg(overall_score), 3) AS avg_score,
        round(avg(faithfulness_score), 3) AS avg_faithfulness,
        round(avg(consistency_index), 3) AS avg_consistency,
        sum(flagged) AS flagged_count,
        sum(contradiction_detected) AS contradiction_count,
        round(sum(flagged) / nullif(count(), 0) * 100, 1) AS flagged_rate_pct
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'knowledge_gap') {
    return `
      SELECT
        count() AS total_evaluations,
        round(avg(overall_score), 3) AS avg_score,
        round(avg(retrieval_precision), 3) AS avg_retrieval_precision,
        round(avg(citation_rate), 3) AS avg_citation_rate,
        sum(gap_detected) AS gap_count,
        sum(flagged) AS flagged_count
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'guardrail_analysis') {
    return `
      SELECT
        count() AS total_evaluations,
        round(avg(overall_score), 3) AS avg_score,
        round(avg(false_positive_score), 3) AS avg_false_positive,
        round(avg(false_negative_score), 3) AS avg_false_negative,
        sum(bypass_detected) AS bypass_count,
        countIf(${GUARDRAIL_FAILURE_PREDICATE}) AS flagged_count,
        round(countIf(${GUARDRAIL_FAILURE_PREDICATE}) / nullif(count(), 0) * 100, 1) AS flagged_rate_pct
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'context_preservation') {
    return `
      SELECT
        count() AS total_evaluations,
        round(avg(overall_score), 3) AS avg_score,
        round(avg(context_score), 3) AS avg_context_score,
        sum(duplication_detected) AS duplication_count,
        sum(handoff_count) AS handoff_count,
        sum(flagged) AS flagged_count
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'friction_detection') {
    return `
      SELECT
        count() AS total_sessions,
        round(avg(friction_score), 3) AS avg_friction_score,
        round(avg(rephrase_count), 2) AS avg_rephrase_count,
        sum(caps_count) AS total_caps_messages,
        sum(exclamation_count) AS total_exclamation_messages,
        sum(flagged) AS flagged_count
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'anomaly_detection') {
    return `
      SELECT
        count() AS total_checks,
        sum(anomaly_flag) AS anomaly_count,
        round(avg(z_score), 3) AS avg_z_score,
        sum(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
        sum(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) AS high_count
      FROM ${source}
      ${sourceScope}
    `;
  } else if (pipelineType === 'llm_evaluate') {
    return `
      SELECT
        count() AS total_evaluations,
        round(avg(overall_score), 3) AS avg_score,
        sum(flagged) AS flagged_count,
        round(sum(flagged) / nullif(count(), 0) * 100, 1) AS flagged_rate_pct
      FROM ${source}
      ${sourceScope}
    `;
  } else {
    // drift_detection (fallthrough)
    return `
      SELECT
        count() AS total_checks,
        round(avg(drift_score), 3) AS avg_drift_score,
        sum(flagged) AS flagged_count,
        sum(CASE WHEN drift_type = 'upward' THEN 1 ELSE 0 END) AS upward_count,
        sum(CASE WHEN drift_type = 'downward' THEN 1 ELSE 0 END) AS downward_count
      FROM ${source}
      ${sourceScope}
    `;
  }
}

/**
 * Execute a pipeline summary query against ClickHouse.
 *
 * Resolves table + dateCol from helpers, builds the query via buildSummaryQuery,
 * appends SETTINGS max_execution_time = 15, and returns the first row.
 *
 * @returns The first result row, or empty object if no data
 */
export async function executePipelineSummary(
  ch: ClickHouseClient,
  tenantId: string,
  projectId: string,
  pipelineType: string,
  period: string,
  offsetDays = 0,
): Promise<Record<string, unknown>> {
  const table = PIPELINE_TABLES[pipelineType];
  const dateCol = PIPELINE_DATE_COLUMNS[pipelineType] ?? 'session_started_at';
  const days = periodToDays(period);

  const query = buildSummaryQuery(pipelineType, table, dateCol, offsetDays);

  const result = await ch.query({
    query: query + '\nSETTINGS max_execution_time = 15',
    query_params: { tenantId, projectId, ...dateWindowQueryParams(days, offsetDays) },
  });
  const rows = parseClickHouseRows(await result.json());
  const row = (rows[0] as Record<string, unknown>) ?? {};

  if (pipelineType === 'quality_evaluation' && rows.length > 0) {
    const custom = aggregateCustomDimensions(row);
    if (custom) row.custom_dimensions = custom;
    delete row._custom_dim_sums;
    delete row._custom_dim_counts;
  }

  return row;
}

function aggregateCustomDimensions(row: Record<string, unknown>): string | undefined {
  const sums = row._custom_dim_sums as [string[], number[]] | null;
  const counts = row._custom_dim_counts as [string[], number[]] | null;
  if (!Array.isArray(sums) || !Array.isArray(counts)) return undefined;
  const keys: unknown[] = sums[0] ?? [];
  const sumVals: unknown[] = sums[1] ?? [];
  const cntVals: unknown[] = counts[1] ?? [];
  const avgMap: Record<string, number> = {};
  for (let i = 0; i < keys.length; i++) {
    const c = Number(cntVals[i]);
    if (c > 0) {
      avgMap[String(keys[i])] = Math.round((Number(sumVals[i]) / c) * 1000) / 1000;
    }
  }
  return Object.keys(avgMap).length > 0 ? JSON.stringify(avgMap) : undefined;
}
