import { z } from 'zod';
import { PACK_NAMES, type PackName } from './pii-pack-names.js';

const CORRECTION_DETECTION_VALUES = ['auto', 'ml', 'llm', 'regex', 'sidecar', 'disabled'] as const;

export const extractionConfigSchema = z.object({
  strategy: z.enum(['auto', 'ml', 'llm', 'hybrid', 'pattern']).optional(),
  correction_detection: z.enum(CORRECTION_DETECTION_VALUES).optional(),
  sidecar_timeout_ms: z.number().optional(),
  sidecar_circuit_breaker_threshold: z.number().optional(),
  nlu_provider: z.enum(['standard', 'advanced']).optional(),
  advanced_sidecar_url: z.string().url().optional(),
  advanced_sidecar_timeout_ms: z.number().min(100).max(30000).optional(),
  advanced_sidecar_circuit_breaker_threshold: z.number().min(1).max(100).optional(),
});

export const multiIntentConfigSchema = z.object({
  enabled: z.boolean().optional(),
  strategy: z.enum(['sequential', 'parallel', 'primary_queue', 'disambiguate', 'auto']).optional(),
  max_intents: z.number().optional(),
  confidence_threshold: z.number().optional(),
  queue_max_age_ms: z.number().optional(),
});

export const inferenceConfigSchema = z.object({
  confidence: z.number().optional(),
  confirm: z.boolean().optional(),
  model_tier: z.string().optional(),
  max_fields_per_pass: z.number().optional(),
});

export const conversionConfigSchema = z.object({
  currency_mode: z.string().optional(),
  currency_api_url: z.string().optional(),
});

export const piiRedactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  redact_input: z.boolean().optional(),
  redact_output: z.boolean().optional(),
  tier: z.enum(['basic', 'standard', 'advanced', 'maximum']).optional(),
  latency_budget_ms: z.number().int().min(50).max(2000).optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  enabled_recognizer_packs: z.array(z.enum([...PACK_NAMES])).optional(),
});

export const compactionConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    tool_results: z
      .object({
        strategy: z.enum(['none', 'truncate', 'structured', 'summarize']).optional(),
        max_chars: z.number().int().min(0).optional(),
        structured_threshold: z.number().int().min(0).optional(),
        keep_recent: z.number().int().min(0).optional(),
        essential_fields: z.record(z.array(z.string().min(1))).optional(),
        max_description_length: z.number().int().min(0).optional(),
        summarize_prompt: z.string().max(20000).optional(),
      })
      .strict()
      .optional(),
    prior_turns: z
      .object({
        strategy: z.enum(['none', 'placeholder', 'compact', 'summarize']).optional(),
        assistant_preview_chars: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const modelSourceSchema = z.enum(['system', 'project', 'tenant', 'default']);

export const promptOverrideRefSchema = z.object({
  promptId: z.string().min(1),
  versionId: z.string().min(1),
  promptName: z.string().max(200).optional(),
  versionNumber: z.number().int().positive().optional(),
});

export const portableTenantModelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  tier: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  displayName: z.string().min(1).optional(),
});

export const pipelineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['parallel', 'sequential']).optional(),
    model: z.string().min(1).optional(),
    modelSource: z.enum(['default', 'tenant']).optional(),
    tenantModelId: z.string().min(1).optional(),
    tenantModelRef: portableTenantModelRefSchema.optional(),
    shortCircuit: z
      .object({
        enabled: z.boolean().optional(),
        confidenceThreshold: z.number().min(0).max(1).optional(),
      })
      .optional(),
    toolFilter: z
      .object({
        enabled: z.boolean().optional(),
        maxTools: z.number().min(1).max(100).optional(),
      })
      .optional(),
    keywordVeto: z
      .object({
        enabled: z.boolean().optional(),
        keywords: z.array(z.string().max(200)).max(500).optional(),
      })
      .optional(),
    intentBridge: z
      .object({
        enabled: z.boolean().optional(),
        programmaticThreshold: z.number().min(0).max(1).optional(),
        guidedThreshold: z.number().min(0).max(1).optional(),
        outOfScopeDecline: z.boolean().optional(),
        multiIntentSignal: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((d) => !(d.modelSource === 'tenant' && !d.tenantModelId && !d.tenantModelRef), {
    message: 'tenantModelId or tenantModelRef is required when modelSource is tenant',
  });

export const fillerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    chatEnabled: z.boolean().optional(),
    voiceEnabled: z.boolean().optional(),
    chatDelayMs: z.number().min(0).max(60000).optional(),
    voiceDelayMs: z.number().min(1).max(60000).optional(),
    cooldownMs: z.number().min(0).max(60000).optional(),
    maxPerTurn: z.number().int().min(0).max(20).optional(),
    piggybackEnabled: z.boolean().optional(),
    pipelineGenerationEnabled: z.boolean().optional(),
    modelSource: modelSourceSchema.optional(),
    modelId: z.string().min(1).optional(),
    tenantModelId: z.string().min(1).optional(),
    tenantModelRef: portableTenantModelRefSchema.optional(),
    promptRef: promptOverrideRefSchema.optional(),
  })
  .refine((d) => !(d.modelSource === 'tenant' && !d.tenantModelId && !d.tenantModelRef), {
    message: 'tenantModelId or tenantModelRef is required when filler modelSource is tenant',
  })
  .refine((d) => !(d.modelSource === 'project' && !d.modelId), {
    message: 'modelId is required when filler modelSource is project',
  });

export const lookupTableEntrySchema = z
  .object({
    name: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'lowercase alphanumeric + underscores only'),
    source: z.enum(['inline', 'collection', 'api']),
    values: z.array(z.string()).max(10000).optional(),
    table_name: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .optional(),
    endpoint: z.string().url().optional(),
    field: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/)
      .optional(),
    timeout_ms: z.number().min(100).max(30000).optional(),
    case_sensitive: z.boolean().optional(),
    fuzzy_match: z.boolean().optional(),
    fuzzy_threshold: z.number().min(0).max(1).optional(),
  })
  .refine(
    (d) => {
      if (d.source === 'inline' && (!d.values || d.values.length === 0)) return false;
      if (d.source === 'collection' && !d.table_name) return false;
      if (d.source === 'api' && !d.endpoint) return false;
      return true;
    },
    {
      message:
        'Source-specific fields required: inline needs values, collection needs table_name, api needs endpoint',
    },
  )
  .refine((d) => !(d.fuzzy_match && d.values && d.values.length > 1000), {
    message: 'Fuzzy matching limited to 1000 inline values for performance',
  });

export const runtimeConfigUpdateSchema = z
  .object({
    operationTierOverrides: z.record(z.string()).optional(),
    extraction: extractionConfigSchema.optional(),
    multi_intent: multiIntentConfigSchema.optional(),
    inference: inferenceConfigSchema.optional(),
    conversion: conversionConfigSchema.optional(),
    pii_redaction: piiRedactionConfigSchema.optional(),
    lookup_tables: z.array(lookupTableEntrySchema).optional(),
    compaction: compactionConfigSchema.optional(),
    pipeline: pipelineConfigSchema.optional(),
    filler: fillerConfigSchema.optional(),
  })
  .strict();

export const PROJECT_RUNTIME_CONFIG_DEFAULTS = {
  operationTierOverrides: {},
  extraction: {
    strategy: 'auto',
    correction_detection: 'ml',
    sidecar_timeout_ms: 500,
    sidecar_circuit_breaker_threshold: 5,
    nlu_provider: 'standard',
    advanced_sidecar_timeout_ms: 3000,
    advanced_sidecar_circuit_breaker_threshold: 5,
  },
  multi_intent: {
    enabled: true,
    strategy: 'primary_queue',
    max_intents: 3,
    confidence_threshold: 0.6,
    queue_max_age_ms: 600_000,
  },
  inference: {
    confidence: 0.8,
    confirm: true,
    model_tier: 'fast',
    max_fields_per_pass: 3,
  },
  conversion: {
    currency_mode: 'static',
  },
  pii_redaction: {
    enabled: true,
    redact_input: true,
    redact_output: false,
    tier: 'basic' as const,
    latency_budget_ms: 200,
    confidence_threshold: 0.5,
    enabled_recognizer_packs: ['core'] as PackName[],
  },
  lookup_tables: [] as z.infer<typeof lookupTableEntrySchema>[],
  filler: {
    enabled: true,
    chatEnabled: true,
    voiceEnabled: true,
    chatDelayMs: 1200,
    voiceDelayMs: 500,
    cooldownMs: 3000,
    maxPerTurn: 5,
    piggybackEnabled: true,
    pipelineGenerationEnabled: true,
    modelSource: 'system',
  },
};

export const runtimeConfigResponseSchema = z.object({
  projectId: z.string(),
  operationTierOverrides: z.record(z.string()),
  extraction: z.object({
    strategy: z.string(),
    correction_detection: z.string(),
    sidecar_timeout_ms: z.number(),
    sidecar_circuit_breaker_threshold: z.number(),
    nlu_provider: z.string(),
    advanced_sidecar_timeout_ms: z.number(),
    advanced_sidecar_circuit_breaker_threshold: z.number(),
    advanced_sidecar_url: z.string().optional(),
  }),
  multi_intent: z.object({
    enabled: z.boolean(),
    strategy: z.string(),
    max_intents: z.number(),
    confidence_threshold: z.number(),
    queue_max_age_ms: z.number(),
  }),
  inference: z.object({
    confidence: z.number(),
    confirm: z.boolean(),
    model_tier: z.string(),
    max_fields_per_pass: z.number(),
  }),
  conversion: z.object({
    currency_mode: z.string(),
    currency_api_url: z.string().optional(),
  }),
  pii_redaction: z.object({
    enabled: z.boolean(),
    redact_input: z.boolean(),
    redact_output: z.boolean(),
    tier: z.enum(['basic', 'standard', 'advanced', 'maximum']).optional(),
    latency_budget_ms: z.number().optional(),
    confidence_threshold: z.number().optional(),
    enabled_recognizer_packs: z.array(z.enum([...PACK_NAMES])).optional(),
  }),
  lookup_tables: z.array(lookupTableEntrySchema),
  compaction: compactionConfigSchema.optional(),
  pipeline: pipelineConfigSchema.optional(),
  filler: fillerConfigSchema,
});

export type RuntimeConfigUpdateInput = z.infer<typeof runtimeConfigUpdateSchema>;
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;
