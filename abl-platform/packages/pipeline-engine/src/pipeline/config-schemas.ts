/**
 * Zod config schemas per pipeline type.
 *
 * Each schema defines the typed, validated shape of the `config` field in
 * `pipeline_configs`. Zod `.default()` values produce sensible platform
 * defaults when parsing an empty object.
 *
 * Used by:
 *   - PipelineConfigService.saveConfig()  — validate before persist
 *   - PipelineConfigService.resolveConfig() — platform defaults as 3rd tier
 *   - PUT /api/.../pipeline-configs/:pipelineType — validate on API boundary
 */
import { z } from 'zod';

function parseNumberLike(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed === '') return value;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

const NumberLikeSchema = z.preprocess(parseNumberLike, z.number().finite());

const QualityDimensionScaleSchema = z
  .preprocess(
    (value) => {
      if (typeof value === 'number') {
        return { min: 1, max: value };
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        const rangeMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
        if (rangeMatch) {
          return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
        }

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          return { min: 1, max: parsed };
        }
      }

      return value;
    },
    z.object({ min: NumberLikeSchema, max: NumberLikeSchema }),
  )
  .refine((scale) => scale.max > scale.min, {
    message: 'scale.max must be greater than scale.min',
  });

// ---------------------------------------------------------------------------
// Shared base schema — fields common to all pipeline configs
// ---------------------------------------------------------------------------

export const SharedPipelineConfigSchema = z.object({
  /** LLM model override (e.g. 'gpt-4o', 'claude-sonnet-4-20250514'). */
  model: z.string().optional(),
  /** Fraction of events to process (0–1). 1.0 = process all. */
  samplingRate: z.number().min(0).max(1).default(1.0),
  /** Per-step config overrides, keyed by step ID. */
  stepOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Per-step timeout overrides in ms, keyed by step ID. */
  timeoutOverrides: z.record(z.string(), z.number().int().positive()).default({}),
});

// ---------------------------------------------------------------------------
// Per-pipeline schemas
// ---------------------------------------------------------------------------

export const SentimentConfigSchema = SharedPipelineConfigSchema.extend({
  /** Score delta to count as a sentiment shift between consecutive messages. */
  shiftThreshold: z.number().min(0).max(1).default(0.3),
  /** Score at or below which a message is considered frustrated. */
  frustrationThreshold: z.number().min(-1).max(0).default(-0.3),
  /** Default confidence assigned to LLM sentiment results. */
  defaultConfidence: z.number().min(0).max(1).default(0.85),
});

export const IntentConfigSchema = SharedPipelineConfigSchema.extend({
  /** Customer-defined intent taxonomy. Empty = auto-discovery mode. */
  taxonomy: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        displayName: z.string().optional(),
        examples: z.array(z.string()).optional(),
        subCategories: z
          .array(
            z.object({
              name: z.string(),
              description: z.string(),
              displayName: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
  /** Minimum confidence for a classification to be accepted. */
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  /** Which messages to send to the LLM for classification. */
  inputMessageStrategy: z
    .enum(['first_n_user', 'last_n_user', 'all_user', 'all'])
    .default('first_n_user'),
  /** Number of messages when using first_n/last_n strategies. */
  inputMessageCount: z.number().int().positive().default(3),
  /** Label assigned when no intent matches the confidence threshold. */
  unknownIntentLabel: z.string().default('unknown'),
  /** Custom system prompt override for intent classification. */
  classificationPrompt: z.string().optional(),
});

export const QualityConfigSchema = SharedPipelineConfigSchema.extend({
  /** Custom evaluation dimensions. Empty = platform defaults. */
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string(),
        description: z.string(),
        scale: QualityDimensionScaleSchema,
        weight: NumberLikeSchema,
        criteria: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  /** Additional domain context injected into the quality evaluation prompt. */
  domainContext: z.string().optional(),
  /** Average score at or below which a conversation is flagged. */
  flagThreshold: z.number().min(0).max(5).default(2.5),
});

export const LLMEvaluationConfigSchema = SharedPipelineConfigSchema.extend({
  /** Score threshold for flagging (interpretation varies by evaluationType). */
  flagThreshold: z.number().optional(),
  /** Override the system prompt for LLM evaluation. */
  systemPromptOverride: z.string().optional(),
});

const BaseStatisticalConfigSchema = SharedPipelineConfigSchema.extend({
  /** ClickHouse table to read metrics from. */
  metricTable: z.string().optional(),
  /** Column name containing the metric value. */
  metricColumn: z.string().optional(),
  /** Number of days to look back for baseline calculation. */
  lookbackDays: z.number().int().positive().default(30),
});

export const StatisticalConfigSchema = BaseStatisticalConfigSchema;

import { isValidMetricTable, isValidMetricColumn, METRIC_TABLE_NAMES } from './metric-sources.js';

const ANOMALY_DEFAULT_TABLE = 'abl_platform.conversation_sentiment';
const ANOMALY_DEFAULT_COLUMN = 'avg_sentiment';
const DRIFT_DEFAULT_TABLE = 'abl_platform.quality_evaluations';
const DRIFT_DEFAULT_COLUMN = 'overall_score';

/**
 * Build a (table, column) pair schema for anomaly/drift configs.
 *
 * Behavior:
 *   - Empty / missing → fall back to the pipeline's curated defaults.
 *   - Unknown table → validation error pointing at `metricTable`.
 *   - Unknown column for the selected table → validation error pointing at
 *     `metricColumn`. This guards against drift where a column gets removed
 *     from the allowlist but a saved config still references it.
 *
 * Keep this as a transform over the parent object (rather than two
 * independent fields) so the column check can see the resolved table.
 */
function applyMetricFieldDefaults<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  defaultTable: string,
  defaultColumn: string,
): z.ZodEffects<T> {
  return schema.superRefine((data, ctx) => {
    const rawTable = (data as { metricTable?: unknown }).metricTable;
    const rawColumn = (data as { metricColumn?: unknown }).metricColumn;

    const resolvedTable =
      typeof rawTable === 'string' && rawTable.length > 0 ? rawTable : defaultTable;
    if (!isValidMetricTable(resolvedTable)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metricTable'],
        message: `Unknown metric table '${resolvedTable}'. Allowed: ${METRIC_TABLE_NAMES.join(', ')}`,
      });
      return;
    }

    const resolvedColumn =
      typeof rawColumn === 'string' && rawColumn.length > 0 ? rawColumn : defaultColumn;
    if (!isValidMetricColumn(resolvedTable, resolvedColumn)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metricColumn'],
        message: `Column '${resolvedColumn}' is not available on table '${resolvedTable}'.`,
      });
      return;
    }

    // Write the resolved (possibly defaulted) values back so consumers always
    // see a complete pair.
    (data as { metricTable: string }).metricTable = resolvedTable;
    (data as { metricColumn: string }).metricColumn = resolvedColumn;
  });
}

export const AnomalyConfigSchema = applyMetricFieldDefaults(
  BaseStatisticalConfigSchema.extend({
    metricTable: z.string().optional(),
    metricColumn: z.string().optional(),
  }),
  ANOMALY_DEFAULT_TABLE,
  ANOMALY_DEFAULT_COLUMN,
);

export const DriftConfigSchema = applyMetricFieldDefaults(
  BaseStatisticalConfigSchema.extend({
    metricTable: z.string().optional(),
    metricColumn: z.string().optional(),
    lookbackDays: z.number().int().positive().default(60),
  }),
  DRIFT_DEFAULT_TABLE,
  DRIFT_DEFAULT_COLUMN,
);

// ---------------------------------------------------------------------------
// Registry: pipelineType → Zod schema
// ---------------------------------------------------------------------------

export const PIPELINE_CONFIG_SCHEMAS: Record<string, z.ZodType> = {
  sentiment_analysis: SentimentConfigSchema,
  intent_classification: IntentConfigSchema,
  quality_evaluation: QualityConfigSchema,
  hallucination_detection: LLMEvaluationConfigSchema,
  knowledge_gap: LLMEvaluationConfigSchema,
  guardrail_analysis: LLMEvaluationConfigSchema,
  context_preservation: LLMEvaluationConfigSchema,
  friction_detection: StatisticalConfigSchema,
  anomaly_detection: AnomalyConfigSchema,
  drift_detection: DriftConfigSchema,
  simulation: SharedPipelineConfigSchema,
};

// ---------------------------------------------------------------------------
// Public API — Static (backward compat)
// ---------------------------------------------------------------------------

/**
 * Validate and apply defaults to a raw config object for a given pipeline type.
 * Returns the parsed config (with defaults filled in) or throws ZodError.
 */
export function parseAndValidateConfig(
  pipelineType: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const schema = PIPELINE_CONFIG_SCHEMAS[pipelineType];
  if (!schema) {
    // Unknown pipeline type — pass through without validation
    return raw;
  }
  return schema.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared config fields — auto-injected into every dynamic schema
// ---------------------------------------------------------------------------

import type { ConfigField } from './types.js';

export const SHARED_CONFIG_FIELDS: ConfigField[] = [
  {
    name: 'model',
    type: 'string',
    required: false,
    description: 'LLM model override (e.g., gpt-4o, claude-sonnet)',
    reprocessOnChange: true,
  },
  {
    name: 'samplingRate',
    type: 'number',
    required: false,
    default: 1.0,
    validation: { min: 0, max: 1 },
    description: 'Fraction of events to process (1.0 = all)',
  },
  {
    name: 'stepOverrides',
    type: 'object',
    required: false,
    default: {},
    description: 'Per-step config overrides keyed by step ID',
  },
  {
    name: 'timeoutOverrides',
    type: 'object',
    required: false,
    default: {},
    description: 'Per-step timeout overrides in ms keyed by step ID',
  },
];

// ---------------------------------------------------------------------------
// Dynamic Zod Schema Builder — from definition configSchema
// ---------------------------------------------------------------------------

/**
 * Build a single Zod field from a ConfigField descriptor.
 */
function buildFieldSchema(field: ConfigField): z.ZodTypeAny {
  switch (field.type) {
    case 'string':
      return z.string();
    case 'number': {
      let n = z.number();
      if (field.validation?.min !== undefined) n = n.min(field.validation.min);
      if (field.validation?.max !== undefined) n = n.max(field.validation.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(field.values as [string, ...string[]]);
    case 'array':
      return z.array(buildItemSchema(field.items));
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Build Zod schema for array item types (either simple ConfigField or object with properties).
 */
function buildItemSchema(items: ConfigField['items']): z.ZodTypeAny {
  if (!items) return z.unknown();

  if ('properties' in items) {
    const objShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propField] of Object.entries(items.properties)) {
      let propZod = buildFieldSchema(propField);
      if (!propField.required) propZod = propZod.optional();
      objShape[key] = propZod;
    }
    return z.object(objShape);
  }

  return buildFieldSchema(items as ConfigField);
}

/**
 * Build a complete Zod schema from a definition's embedded configSchema.
 * Shared fields (model, samplingRate, etc.) are auto-injected.
 */
export function buildZodSchema(configSchema: { fields: ConfigField[] }): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of configSchema.fields) {
    if (field.type === 'info') continue;

    let zodField = buildFieldSchema(field);

    if (!field.required) zodField = zodField.optional();
    if (field.default !== undefined) zodField = zodField.default(field.default);

    shape[field.name] = zodField;
  }

  // Inject shared fields (model, samplingRate, etc.)
  return z.object({
    model: z.string().optional(),
    samplingRate: z.number().min(0).max(1).default(1.0),
    stepOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    timeoutOverrides: z.record(z.string(), z.number()).default({}),
    ...shape,
  });
}

/**
 * Validate and apply defaults using a definition's embedded configSchema.
 * Returns the parsed config or throws ZodError.
 */
export function parseAndValidateConfigFromDefinition(
  definition: { configSchema: { fields: ConfigField[] } },
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  const schema = buildZodSchema(definition.configSchema);
  return schema.parse(rawConfig) as Record<string, unknown>;
}
