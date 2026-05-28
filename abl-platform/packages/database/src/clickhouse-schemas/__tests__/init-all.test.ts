import { describe, expect, it } from 'vitest';
import { getSchemaInventory } from '../init-all.js';

describe('getSchemaInventory', () => {
  it('returns core table names', () => {
    const { tables } = getSchemaInventory();
    // Spot-check a representative sample of core tables
    expect(tables).toContain('messages');
    expect(tables).toContain('platform_events');
    expect(tables).toContain('audit_events');
    expect(tables).toContain('llm_metrics');
    expect(tables).toContain('logs');
    expect(tables).toContain('facts');
    expect(tables).toContain('feedback');
    expect(tables).toContain('arch_audit_log');
    expect(tables).toContain('kms_audit_log');
    expect(tables).toContain('search_queries');
  });

  it('returns all analytics table names', () => {
    const { tables } = getSchemaInventory();
    expect(tables).toContain('message_sentiment');
    expect(tables).toContain('conversation_sentiment');
    expect(tables).toContain('intent_classifications');
    expect(tables).toContain('quality_evaluations');
    expect(tables).toContain('custom_events');
    expect(tables).toContain('conversation_outcomes');
    expect(tables).toContain('goal_completions');
    expect(tables).toContain('toxicity_evaluations');
    expect(tables).toContain('llm_evaluate');
  });

  it('returns all eval table names', () => {
    const { tables } = getSchemaInventory();
    expect(tables).toContain('eval_conversations');
    expect(tables).toContain('eval_scores');
    expect(tables).toContain('eval_production_scores');
  });

  it('returns experiment_assignments', () => {
    const { tables } = getSchemaInventory();
    expect(tables).toContain('experiment_assignments');
  });

  it('returns all workflow table names', () => {
    const { tables } = getSchemaInventory();
    expect(tables).toContain('workflow_execution_events');
    expect(tables).toContain('workflow_executions_latest');
    expect(tables).toContain('human_task_events');
    expect(tables).toContain('human_tasks_latest');
  });

  it('returns all MV names', () => {
    const { materializedViews } = getSchemaInventory();
    // Core MVs
    expect(materializedViews).toContain('llm_metrics_hourly');
    expect(materializedViews).toContain('llm_metrics_daily');
    expect(materializedViews).toContain('platform_events_by_session_mv');
    // Analytics MVs
    expect(materializedViews).toContain('mv_daily_sentiment');
    expect(materializedViews).toContain('mv_daily_intent_distribution');
    expect(materializedViews).toContain('mv_daily_quality_scores');
    // Eval MVs
    expect(materializedViews).toContain('mv_eval_heatmap');
    expect(materializedViews).toContain('mv_eval_run_evaluator_summary');
    // Workflow MVs
    expect(materializedViews).toContain('workflow_executions_latest_mv');
    expect(materializedViews).toContain('human_tasks_latest_mv');
  });

  it('does NOT include unmanaged patterns (structured_data_*, traces, table_metadata)', () => {
    const { tables } = getSchemaInventory();
    const unmanaged = tables.filter(
      (t) => t.startsWith('structured_data_') || t === 'traces' || t === 'table_metadata',
    );
    expect(unmanaged).toHaveLength(0);
  });

  it('returns no duplicate table names', () => {
    const { tables } = getSchemaInventory();
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });

  it('returns no duplicate materialized view names', () => {
    const { materializedViews } = getSchemaInventory();
    const unique = new Set(materializedViews);
    expect(unique.size).toBe(materializedViews.length);
  });
});
