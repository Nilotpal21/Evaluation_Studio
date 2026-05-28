/**
 * Curated allowlist of ClickHouse tables + columns that Anomaly Detection and
 * Drift Detection are allowed to read from.
 *
 * Two-field contract for v1: { metricTable, metricColumn }. Filter / groupBy
 * dimensions intentionally left out — see SDLC notes for the dynamic expansion.
 *
 * Every entry must satisfy:
 *   - table has `tenant_id`, `project_id`, `session_started_at` (required by
 *     the AD/Drift query in compute-statistical.service.ts).
 *   - column is numeric (`Float32`, `UInt8`, `UInt32`) and produces a
 *     meaningful value when averaged over a time bucket.
 *
 * Adding a metric column?
 *   1. Verify the column exists in the storage table definition under
 *      `seed-data/node-type-definitions.json`.
 *   2. Add it here with a user-facing label and description (rendered as the
 *      subscript in the Studio config form, so write for a non-technical
 *      reader).
 *   3. If the column is a `UInt8` flag, call it out in the description
 *      (e.g. "rate per session, 0–1") — averaging a flag column gives a rate,
 *      not a count.
 */

export interface MetricColumn {
  /** Physical column name in ClickHouse. */
  name: string;
  /** Display label for the dropdown. */
  label: string;
  /** End-user description shown as a subscript under the column dropdown. */
  description: string;
  /** Optional unit hint appended to the label (e.g. "0–1", "count/session"). */
  unit?: string;
}

export interface MetricTable {
  /** Fully-qualified ClickHouse table name. */
  table: string;
  /** Display label for the table dropdown. */
  label: string;
  /** End-user description shown as a subscript under the table dropdown. */
  description: string;
  /** Default metric column for this table (selected when the user picks the table). */
  defaultColumn: string;
  /** Allowed metric columns for this table. */
  columns: MetricColumn[];
}

export const METRIC_SOURCES: MetricTable[] = [
  {
    table: 'abl_platform.conversation_sentiment',
    label: 'Conversation Sentiment',
    description: 'Per-session sentiment signals produced by the sentiment-analysis pipeline.',
    defaultColumn: 'avg_sentiment',
    columns: [
      {
        name: 'avg_sentiment',
        label: 'Average Sentiment',
        description:
          'Mean sentiment score across all messages in the session (-1 negative … +1 positive).',
        unit: '-1 to 1',
      },
      {
        name: 'start_sentiment',
        label: 'Starting Sentiment',
        description: 'Sentiment of the first message in the session.',
        unit: '-1 to 1',
      },
      {
        name: 'end_sentiment',
        label: 'Ending Sentiment',
        description: 'Sentiment of the last message in the session.',
        unit: '-1 to 1',
      },
      {
        name: 'worst_pivot_delta',
        label: 'Worst Sentiment Drop',
        description:
          'Largest negative shift between two consecutive messages — captures the moment things went bad.',
        unit: '-1 to 1',
      },
      {
        name: 'frustration_detected',
        label: 'Frustration Rate',
        description:
          'Fraction of sessions where frustration was detected (0 = none, 1 = every session).',
        unit: '0 to 1',
      },
    ],
  },
  {
    table: 'abl_platform.intent_classifications',
    label: 'Intent Classifications',
    description: 'Per-session intent classification produced by the intent pipeline.',
    defaultColumn: 'confidence',
    columns: [
      {
        name: 'confidence',
        label: 'Classification Confidence',
        description:
          'Average LLM confidence in the chosen intent. A drop indicates the taxonomy may be going stale or user phrasing is shifting.',
        unit: '0 to 1',
      },
      {
        name: 'is_auto_discovered',
        label: 'Out-of-Taxonomy Rate',
        description:
          'Fraction of sessions where the intent did not match the configured taxonomy. A spike indicates users asking about new topics.',
        unit: '0 to 1',
      },
    ],
  },
  {
    table: 'abl_platform.quality_evaluations',
    label: 'Quality Evaluations',
    description: 'Per-session quality scores produced by the quality-evaluation pipeline.',
    defaultColumn: 'overall_score',
    columns: [
      {
        name: 'overall_score',
        label: 'Overall Quality Score',
        description: 'Weighted average across all enabled quality dimensions.',
        unit: '1 to 5',
      },
      {
        name: 'helpfulness',
        label: 'Helpfulness',
        description: 'How well the agent addressed the user’s actual need.',
        unit: '1 to 5',
      },
      {
        name: 'accuracy',
        label: 'Accuracy',
        description: 'Whether the agent’s answers were factually correct.',
        unit: '1 to 5',
      },
      {
        name: 'professionalism',
        label: 'Professionalism',
        description: 'Tone, courtesy, and adherence to brand voice.',
        unit: '1 to 5',
      },
      {
        name: 'instruction_following',
        label: 'Instruction Following',
        description: 'How closely the agent stayed on task and respected system instructions.',
        unit: '1 to 5',
      },
      {
        name: 'flagged',
        label: 'Flagged Rate',
        description:
          'Fraction of sessions flagged for review (overall score below the configured threshold).',
        unit: '0 to 1',
      },
    ],
  },
  {
    table: 'abl_platform.hallucination_evaluations',
    label: 'Hallucination Evaluations',
    description: 'Per-session hallucination/faithfulness scores from the hallucination pipeline.',
    defaultColumn: 'faithfulness_score',
    columns: [
      {
        name: 'overall_score',
        label: 'Overall Score',
        description: 'Composite hallucination evaluation score.',
        unit: '0 to 1',
      },
      {
        name: 'faithfulness_score',
        label: 'Faithfulness Score',
        description:
          'Degree to which the agent’s answers are grounded in the provided knowledge sources.',
        unit: '0 to 1',
      },
      {
        name: 'consistency_index',
        label: 'Consistency Index',
        description: 'How internally consistent the agent’s claims are across the conversation.',
        unit: '0 to 1',
      },
      {
        name: 'flagged',
        label: 'Flagged Rate',
        description: 'Fraction of sessions flagged for hallucination.',
        unit: '0 to 1',
      },
      {
        name: 'contradiction_detected',
        label: 'Contradiction Rate',
        description:
          'Fraction of sessions where the agent contradicted itself or the source material.',
        unit: '0 to 1',
      },
    ],
  },
  {
    table: 'abl_platform.knowledge_gap_evaluations',
    label: 'Knowledge Gap Evaluations',
    description: 'Per-session RAG/knowledge-gap signals from the knowledge-gap pipeline.',
    defaultColumn: 'retrieval_precision',
    columns: [
      {
        name: 'overall_score',
        label: 'Overall Score',
        description: 'Composite knowledge-gap evaluation score.',
        unit: '0 to 1',
      },
      {
        name: 'retrieval_precision',
        label: 'Retrieval Precision',
        description:
          'Fraction of retrieved articles that were actually relevant to the user’s question.',
        unit: '0 to 1',
      },
      {
        name: 'citation_rate',
        label: 'Citation Rate',
        description: 'Fraction of answers that included a citation to a knowledge source.',
        unit: '0 to 1',
      },
      {
        name: 'flagged',
        label: 'Flagged Rate',
        description: 'Fraction of sessions flagged for a likely knowledge gap.',
        unit: '0 to 1',
      },
      {
        name: 'gap_detected',
        label: 'Gap Detection Rate',
        description:
          'Fraction of sessions where the evaluator concluded the knowledge base was missing relevant content.',
        unit: '0 to 1',
      },
    ],
  },
  {
    table: 'abl_platform.guardrail_evaluations',
    label: 'Guardrail Evaluations',
    description: 'Per-session safety/policy evaluation signals from the guardrail pipeline.',
    defaultColumn: 'overall_score',
    columns: [
      {
        name: 'overall_score',
        label: 'Overall Score',
        description: 'Composite guardrail evaluation score.',
        unit: '0 to 1',
      },
      {
        name: 'false_positive_score',
        label: 'False Positive Score',
        description: 'How often the guardrail blocked benign content.',
        unit: '0 to 1',
      },
      {
        name: 'false_negative_score',
        label: 'False Negative Score',
        description: 'How often the guardrail missed content that should have been blocked.',
        unit: '0 to 1',
      },
      {
        name: 'flagged',
        label: 'Flagged Rate',
        description: 'Fraction of sessions flagged by the guardrail.',
        unit: '0 to 1',
      },
      {
        name: 'bypass_detected',
        label: 'Bypass Detection Rate',
        description: 'Fraction of sessions where a guardrail bypass attempt was detected.',
        unit: '0 to 1',
      },
    ],
  },
  {
    table: 'abl_platform.context_evaluations',
    label: 'Context Evaluations',
    description:
      'Per-session multi-turn coherence and context-retention signals from the context-preservation pipeline.',
    defaultColumn: 'context_score',
    columns: [
      {
        name: 'overall_score',
        label: 'Overall Score',
        description: 'Composite context evaluation score.',
        unit: '0 to 1',
      },
      {
        name: 'context_score',
        label: 'Context Retention Score',
        description: 'How well the agent retained and used earlier context across turns.',
        unit: '0 to 1',
      },
      {
        name: 'flagged',
        label: 'Flagged Rate',
        description: 'Fraction of sessions flagged for poor context handling.',
        unit: '0 to 1',
      },
      {
        name: 'duplication_detected',
        label: 'Duplication Rate',
        description:
          'Fraction of sessions where the agent repeated information it had already provided.',
        unit: '0 to 1',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE_INDEX = new Map<string, MetricTable>(METRIC_SOURCES.map((t) => [t.table, t]));

export function getMetricTables(): MetricTable[] {
  return METRIC_SOURCES;
}

export function getMetricTable(table: string): MetricTable | undefined {
  return TABLE_INDEX.get(table);
}

export function getMetricColumns(table: string): MetricColumn[] {
  return TABLE_INDEX.get(table)?.columns ?? [];
}

export function isValidMetricTable(table: unknown): table is string {
  return typeof table === 'string' && TABLE_INDEX.has(table);
}

export function isValidMetricColumn(table: string, column: unknown): column is string {
  if (typeof column !== 'string') return false;
  const entry = TABLE_INDEX.get(table);
  return !!entry && entry.columns.some((c) => c.name === column);
}

/** Convenience list of all valid table names. */
export const METRIC_TABLE_NAMES: readonly string[] = METRIC_SOURCES.map((t) => t.table);

// ---------------------------------------------------------------------------
// Schema-endpoint resolver
// ---------------------------------------------------------------------------

import type { ConfigField, ConfigFieldOption } from './types.js';

/**
 * Expand a ConfigField with `dynamicOptions: 'metric-tables' | 'metric-columns'`
 * into a self-contained field carrying inline `options` (or
 * `optionsByDependency`). The schema endpoint runs this before returning the
 * fields so Studio doesn't need to make a second round-trip for static data.
 *
 * Fields without a metric-* dynamicOption pass through unchanged.
 */
export function resolveMetricDynamicOptions(field: ConfigField): ConfigField {
  if (field.dynamicOptions === 'metric-tables') {
    const options: ConfigFieldOption[] = METRIC_SOURCES.map((t) => ({
      value: t.table,
      label: t.label,
      description: t.description,
    }));
    return { ...field, options };
  }

  if (field.dynamicOptions === 'metric-columns') {
    const optionsByTable: Record<string, ConfigFieldOption[]> = {};
    for (const t of METRIC_SOURCES) {
      optionsByTable[t.table] = t.columns.map((c) => ({
        value: c.name,
        label: c.unit ? `${c.label} (${c.unit})` : c.label,
        description: c.description,
      }));
    }
    return {
      ...field,
      optionsByDependency: {
        field: 'metricTable',
        options: optionsByTable,
      },
    };
  }

  return field;
}

/** Apply `resolveMetricDynamicOptions` to every field in an array. */
export function resolveMetricDynamicOptionsAll(fields: ConfigField[]): ConfigField[] {
  return fields.map(resolveMetricDynamicOptions);
}
