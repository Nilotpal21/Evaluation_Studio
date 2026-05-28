/**
 * Schema Resolver
 *
 * Resolves the output table schema for a pipeline by:
 *   1. Checking a built-in pipeline → ClickHouse table mapping (builtin
 *      compute steps write directly to their own tables, not via
 *      store-results nodes).
 *   2. Falling back to inspecting the definition's store-results /
 *      store-insight node for custom pipelines.
 *
 * The resolved schema tells the query builder which ClickHouse table to
 * read and which columns are available / filterable / exportable.
 *
 * Uses a simple in-process TTL cache (60 s) to avoid repeated Mongo lookups
 * for the same pipeline during interactive preview sessions.
 */

import { CUSTOM_PIPELINE_RESULTS_TABLE } from '@agent-platform/pipeline-engine/contracts';

// ─── Public Types ─────────────────────────────────────────────────────────

export interface ColumnMeta {
  name: string;
  type: string;
  filterable: boolean;
  exportable: boolean;
  description?: string;
}

export interface OutputSchema {
  table: string;
  columns: ColumnMeta[];
}

export class OutputSchemaError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'NO_OUTPUT_TABLE',
    message: string,
  ) {
    super(message);
    this.name = 'OutputSchemaError';
  }
}

// ─── Builtin Pipeline Table Mapping ──────────────────────────────────────

/** Column helper — marks a column as filterable + exportable by default */
function col(
  name: string,
  type: string,
  opts: { filterable?: boolean; exportable?: boolean; description?: string } = {},
): ColumnMeta {
  return {
    name,
    type,
    filterable: opts.filterable ?? true,
    exportable: opts.exportable ?? true,
    description: opts.description,
  };
}

/** Common columns present on most analytics tables */
const COMMON_COLS: ColumnMeta[] = [
  col('tenant_id', 'String', { filterable: false, exportable: false }),
  col('project_id', 'String', { filterable: false, exportable: false }),
  col('session_id', 'String', { description: 'Conversation session' }),
  col('session_started_at', 'DateTime64(3)', { filterable: false }),
  col('processed_at', 'DateTime64(3)', { filterable: false }),
  col('agent_name', 'String'),
  col('channel', 'String'),
];

interface BuiltinTableDef {
  table: string;
  extraColumns: ColumnMeta[];
}

function hasDeclaredOutputSchema(config: Record<string, unknown> | undefined): boolean {
  const outputSchema = config?.outputSchema as { columns?: unknown[] } | undefined;
  return Array.isArray(outputSchema?.columns) && outputSchema.columns.length > 0;
}

function isClickHouseDestination(config: Record<string, unknown> | undefined): boolean {
  const destination = config?.destination as string | undefined;
  return destination === undefined || destination === 'clickhouse';
}

function preferRicherStoreConfig(
  current: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  if (!current) return candidate;
  if (!hasDeclaredOutputSchema(current) && hasDeclaredOutputSchema(candidate)) {
    return candidate;
  }
  return current;
}

/**
 * Maps builtin pipeline IDs to their primary ClickHouse output table and
 * the columns specific to that table (beyond the common columns).
 */
const BUILTIN_TABLE_MAP: Record<string, BuiltinTableDef> = {
  'builtin:sentiment-analysis': {
    table: 'abl_platform.conversation_sentiment',
    extraColumns: [
      col('avg_sentiment', 'Float32', { description: 'Average sentiment score' }),
      col('start_sentiment', 'Float32'),
      col('end_sentiment', 'Float32'),
      col('min_sentiment', 'Float32', { filterable: false }),
      col('max_sentiment', 'Float32', { filterable: false }),
      col('sentiment_trajectory', 'String', { description: 'improving / declining / stable' }),
      col('sentiment_shift_count', 'UInt16', { filterable: false }),
      col('frustration_detected', 'UInt8'),
      col('frustration_turn_count', 'UInt16', { filterable: false }),
      col('model_id', 'String', { filterable: false }),
      col('message_count', 'UInt16', { filterable: false }),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
  'builtin:intent-classification': {
    table: 'abl_platform.intent_classifications',
    extraColumns: [
      col('intent', 'String', { description: 'Primary classified intent' }),
      col('intent_display', 'String', { filterable: false }),
      col('sub_intent', 'String'),
      col('confidence', 'Float32'),
      col('is_auto_discovered', 'UInt8', { filterable: false }),
      col('model_id', 'String', { filterable: false }),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
  'builtin:quality-evaluation': {
    table: 'abl_platform.quality_evaluations',
    extraColumns: [
      col('overall_score', 'Float32', { description: 'Composite quality score' }),
      col('helpfulness', 'Float32'),
      col('accuracy', 'Float32'),
      col('professionalism', 'Float32'),
      col('instruction_following', 'Float32'),
      col('flagged', 'UInt8'),
      col('flag_reasons', 'Array(String)', { filterable: false }),
      col('reasoning', 'String', { filterable: false }),
      col('model_id', 'String', { filterable: false }),
      col('confidence', 'Float32', { filterable: false }),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
  'builtin:hallucination-detection': {
    table: 'abl_platform.hallucination_evaluations',
    extraColumns: [
      col('evaluation_type', 'String'),
      col('overall_score', 'Float64', { description: 'Hallucination score' }),
      col('faithfulness_score', 'Float64'),
      col('consistency_index', 'Float64', { filterable: false }),
      col('contradiction_detected', 'UInt8'),
      col('flagged', 'UInt8'),
      col('flag_reasons', 'Array(String)', { filterable: false }),
      col('confidence', 'Float64', { filterable: false }),
      col('model_id', 'String', { filterable: false }),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
  'builtin:knowledge-gap-analysis': {
    table: 'abl_platform.knowledge_gap_evaluations',
    extraColumns: [
      col('evaluation_type', 'String'),
      col('overall_score', 'Float64', { description: 'Knowledge gap score' }),
      col('retrieval_precision', 'Float64'),
      col('citation_rate', 'Float64'),
      col('gap_detected', 'UInt8'),
      col('gap_topics', 'Array(String)', { filterable: false }),
      col('flagged', 'UInt8'),
      col('flag_reasons', 'Array(String)', { filterable: false }),
      col('confidence', 'Float64', { filterable: false }),
      col('model_id', 'String', { filterable: false }),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
  'builtin:guardrail-analysis': {
    table: 'abl_platform.guardrail_evaluations',
    extraColumns: [
      col('evaluation_type', 'String'),
      col('overall_score', 'Float64', { description: 'Guardrail compliance score' }),
      col('false_positive_score', 'Float64', { filterable: false }),
      col('false_negative_score', 'Float64', { filterable: false }),
      col('bypass_detected', 'UInt8'),
      col('severity', 'String'),
      col('violation_categories', 'Array(String)', { filterable: false }),
      col('flagged', 'UInt8'),
      col('flag_reasons', 'Array(String)', { filterable: false }),
      col('confidence', 'Float64', { filterable: false }),
      col('model_id', 'String', { filterable: false }),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
  'builtin:friction-detection': {
    table: 'abl_platform.friction_detections',
    extraColumns: [
      col('friction_score', 'Float64', { description: 'Friction score' }),
      col('rephrase_count', 'UInt16'),
      col('message_length_trend', 'Float64', { filterable: false }),
      col('turn_count_zscore', 'Float64', { filterable: false }),
      col('caps_count', 'UInt16', { filterable: false }),
      col('exclamation_count', 'UInt16', { filterable: false }),
      col('flagged', 'UInt8'),
      col('processing_ms', 'UInt32', { filterable: false }),
    ],
  },
};

/**
 * Returns all builtin pipeline IDs that have a known output table.
 * Used by the previewable-pipelines endpoint.
 */
export function getBuiltinPreviewablePipelines(): Array<{
  pipelineId: string;
  table: string;
}> {
  return Object.entries(BUILTIN_TABLE_MAP).map(([pipelineId, def]) => ({
    pipelineId,
    table: def.table,
  }));
}

// ─── Cache ────────────────────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 500;
const TTL_MS = 60_000;
const cache = new Map<string, { expires: number; schema: OutputSchema }>();

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expires <= now) cache.delete(k);
  }
}

// ─── Resolver ─────────────────────────────────────────────────────────────

export async function resolveOutputSchema(
  pipelineId: string,
  tenantId: string,
): Promise<OutputSchema> {
  const key = `${tenantId}:${pipelineId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.schema;

  // 1. Check builtin mapping first — these pipelines write directly from
  //    compute steps, not via store-results nodes.
  const builtin = BUILTIN_TABLE_MAP[pipelineId];
  if (builtin) {
    const schema: OutputSchema = {
      table: builtin.table,
      columns: [...COMMON_COLS, ...builtin.extraColumns],
    };
    cacheSet(key, schema);
    return schema;
  }

  // 2. Fall back to inspecting the pipeline definition's store-results node.
  //    Runtime relies on the Mongo connection established at startup —
  //    no ensureDb() here.
  const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');

  const def = (await PipelineDefinitionModel.findOne({
    _id: pipelineId,
    tenantId: { $in: ['__platform__', tenantId] },
    status: 'active',
  }).lean()) as Record<string, unknown> | null;

  if (!def) throw new OutputSchemaError('NOT_FOUND', 'Pipeline not found');

  // Search graph nodes, legacy steps, and strategy steps for a store-results entry.
  const isStoreActivity = (type?: string, activity?: string) =>
    type === 'store-results' ||
    type === 'store-insight' ||
    activity === 'store-results' ||
    activity === 'store-insight';

  let storeConfig: Record<string, unknown> | undefined;

  // 2a. Graph-based nodes
  const nodes = (def.nodes ?? []) as Array<Record<string, unknown>>;
  for (const n of nodes) {
    if (isStoreActivity(n.type as string | undefined)) {
      storeConfig = preferRicherStoreConfig(
        storeConfig,
        (n.config ?? {}) as Record<string, unknown>,
      );
      if (hasDeclaredOutputSchema(storeConfig)) break;
    }
  }

  // 2b. Legacy flat steps
  const steps = (def.steps ?? []) as Array<Record<string, unknown>>;
  for (const s of steps) {
    if (isStoreActivity(s.type as string | undefined, s.activity as string | undefined)) {
      storeConfig = preferRicherStoreConfig(
        storeConfig,
        (s.config ?? {}) as Record<string, unknown>,
      );
      if (hasDeclaredOutputSchema(storeConfig)) break;
    }
  }

  // 2c. Strategy steps (strategies is a Map in Mongoose, plain object after .lean())
  if (def.strategies) {
    const rawStrategies = def.strategies;
    const strategies =
      rawStrategies instanceof Map
        ? (Object.fromEntries(rawStrategies) as Record<
            string,
            { steps?: Array<Record<string, unknown>> }
          >)
        : (rawStrategies as Record<string, { steps?: Array<Record<string, unknown>> }>);
    for (const strategy of Object.values(strategies)) {
      for (const s of strategy.steps ?? []) {
        if (isStoreActivity(s.type as string | undefined, s.activity as string | undefined)) {
          storeConfig = preferRicherStoreConfig(
            storeConfig,
            (s.config ?? {}) as Record<string, unknown>,
          );
          if (hasDeclaredOutputSchema(storeConfig)) break;
        }
      }
      if (storeConfig && hasDeclaredOutputSchema(storeConfig)) break;
    }
  }

  const pipelineName = typeof def.name === 'string' ? def.name : pipelineId;

  if (!storeConfig) {
    throw new OutputSchemaError(
      'NO_OUTPUT_TABLE',
      `Pipeline "${pipelineName}" has no store-results node — nothing to preview`,
    );
  }

  const table =
    (storeConfig.table as string | undefined) ??
    (isClickHouseDestination(storeConfig) ? CUSTOM_PIPELINE_RESULTS_TABLE : undefined);

  if (!table) {
    throw new OutputSchemaError(
      'NO_OUTPUT_TABLE',
      `Pipeline "${pipelineName}" store-results node has no table configured`,
    );
  }

  const outputSchema = storeConfig.outputSchema as { columns?: ColumnMeta[] } | undefined;
  const declared = (outputSchema?.columns ?? []) as ColumnMeta[];

  // Always include isolation + metadata columns that the query builder relies on.
  // Custom store-results rows are written with created_at, not processed_at.
  const baseCols: ColumnMeta[] =
    table === CUSTOM_PIPELINE_RESULTS_TABLE
      ? [
          { name: 'tenant_id', type: 'String', filterable: false, exportable: false },
          { name: 'project_id', type: 'String', filterable: false, exportable: false },
          { name: 'pipeline_id', type: 'String', filterable: false, exportable: true },
          { name: 'pipeline_name', type: 'String', filterable: true, exportable: true },
          { name: 'pipeline_kind', type: 'String', filterable: true, exportable: true },
          { name: 'run_id', type: 'String', filterable: true, exportable: true },
          { name: 'session_id', type: 'String', filterable: true, exportable: true },
          { name: 'store_step_id', type: 'String', filterable: true, exportable: true },
          { name: 'source_step_id', type: 'String', filterable: true, exportable: true },
          { name: 'source_step_status', type: 'String', filterable: true, exportable: true },
          { name: 'trigger_id', type: 'String', filterable: true, exportable: true },
          { name: 'execution_mode', type: 'String', filterable: true, exportable: true },
          { name: 'source', type: 'String', filterable: true, exportable: true },
          { name: 'score_name', type: 'String', filterable: true, exportable: true },
          { name: 'score_path', type: 'String', filterable: true, exportable: true },
          { name: 'score_value', type: 'Float64', filterable: true, exportable: true },
          { name: 'output_json', type: 'String', filterable: true, exportable: true },
          { name: 'created_at', type: 'DateTime64(3)', filterable: false, exportable: true },
        ]
      : [
          { name: 'tenant_id', type: 'String', filterable: false, exportable: false },
          { name: 'project_id', type: 'String', filterable: false, exportable: false },
          { name: 'run_id', type: 'String', filterable: true, exportable: true },
          { name: 'pipeline_id', type: 'String', filterable: false, exportable: true },
          { name: 'session_id', type: 'String', filterable: true, exportable: true },
          { name: 'created_at', type: 'DateTime64(3)', filterable: false, exportable: true },
        ];

  // Merge by name — declared columns take precedence over base
  const byName = new Map<string, ColumnMeta>();
  for (const c of baseCols) byName.set(c.name, c);
  for (const c of declared) byName.set(c.name, c);

  const schema: OutputSchema = {
    table,
    columns: [...byName.values()],
  };

  cacheSet(key, schema);
  return schema;
}

function cacheSet(key: string, schema: OutputSchema): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    evictExpired();
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(key, { expires: Date.now() + TTL_MS, schema });
}

export function clearSchemaCache(): void {
  cache.clear();
}
