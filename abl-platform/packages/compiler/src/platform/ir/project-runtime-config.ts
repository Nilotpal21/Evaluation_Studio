import type {
  CompactionPolicyOverride,
  LookupTableIR,
  PriorTurnCompactionStrategy,
  ProjectRuntimeConfigIR,
  RuntimeFillerConfigIR,
  RuntimeModelSourceIR,
  ToolResultCompactionStrategy,
} from './schema.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function stringArrayRecordValue(value: unknown): Record<string, string[]> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;

  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(source)) {
    const strings = stringArrayValue(entry);
    if (strings) {
      result[key] = strings;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function mapCompactionConfig(input: unknown): CompactionPolicyOverride | undefined {
  const source = asRecord(input);
  if (!source) return undefined;

  const compaction: CompactionPolicyOverride = {};
  const model = stringValue(source.model);
  if (model) {
    compaction.model = model;
  }

  const toolResults = asRecord(source.tool_results);
  if (toolResults) {
    compaction.tool_results = {
      ...(stringValue(toolResults.strategy)
        ? { strategy: stringValue(toolResults.strategy) as ToolResultCompactionStrategy }
        : {}),
      ...(numberValue(toolResults.max_chars) !== undefined
        ? { max_chars: numberValue(toolResults.max_chars) }
        : {}),
      ...(numberValue(toolResults.structured_threshold) !== undefined
        ? { structured_threshold: numberValue(toolResults.structured_threshold) }
        : {}),
      ...(numberValue(toolResults.keep_recent) !== undefined
        ? { keep_recent: numberValue(toolResults.keep_recent) }
        : {}),
      ...(stringArrayRecordValue(toolResults.essential_fields)
        ? { essential_fields: stringArrayRecordValue(toolResults.essential_fields) }
        : {}),
      ...(numberValue(toolResults.max_description_length) !== undefined
        ? { max_description_length: numberValue(toolResults.max_description_length) }
        : {}),
      ...(stringValue(toolResults.summarize_prompt)
        ? { summarize_prompt: stringValue(toolResults.summarize_prompt) }
        : {}),
    };
  }

  const priorTurns = asRecord(source.prior_turns);
  if (priorTurns) {
    compaction.prior_turns = {
      ...(stringValue(priorTurns.strategy)
        ? { strategy: stringValue(priorTurns.strategy) as PriorTurnCompactionStrategy }
        : {}),
      ...(numberValue(priorTurns.assistant_preview_chars) !== undefined
        ? { assistant_preview_chars: numberValue(priorTurns.assistant_preview_chars) }
        : {}),
    };
  }

  return Object.keys(compaction).length > 0 ? compaction : undefined;
}

function mapPipelineConfig(input: unknown): ProjectRuntimeConfigIR['pipeline'] | undefined {
  const source = asRecord(input);
  if (!source) return undefined;

  const shortCircuit = asRecord(source.shortCircuit);
  const toolFilter = asRecord(source.toolFilter);
  const keywordVeto = asRecord(source.keywordVeto);
  const intentBridge = asRecord(source.intentBridge);

  return {
    enabled: booleanValue(source.enabled) ?? false,
    mode:
      (stringValue(source.mode) as NonNullable<ProjectRuntimeConfigIR['pipeline']>['mode']) ??
      'parallel',
    modelSource: (stringValue(source.modelSource) as 'default' | 'tenant') ?? 'default',
    tenantModelId: stringValue(source.tenantModelId),
    shortCircuit: {
      enabled: booleanValue(shortCircuit?.enabled) ?? true,
      confidenceThreshold: numberValue(shortCircuit?.confidenceThreshold) ?? 0.85,
    },
    toolFilter: {
      enabled: booleanValue(toolFilter?.enabled) ?? true,
      maxTools: numberValue(toolFilter?.maxTools) ?? 6,
    },
    keywordVeto: {
      enabled: booleanValue(keywordVeto?.enabled) ?? true,
      keywords: stringArrayValue(keywordVeto?.keywords) ?? [],
    },
    intentBridge: {
      enabled: booleanValue(intentBridge?.enabled) ?? true,
      programmaticThreshold: numberValue(intentBridge?.programmaticThreshold) ?? 0.85,
      guidedThreshold: numberValue(intentBridge?.guidedThreshold) ?? 0.5,
      outOfScopeDecline: booleanValue(intentBridge?.outOfScopeDecline) ?? true,
      multiIntentSignal: booleanValue(intentBridge?.multiIntentSignal) ?? true,
    },
  };
}

function mapFillerConfig(input: unknown): RuntimeFillerConfigIR | undefined {
  const source = asRecord(input);
  if (!source) return undefined;

  const rawModelSource = stringValue(source.modelSource);
  return {
    enabled: booleanValue(source.enabled) ?? true,
    chatEnabled: booleanValue(source.chatEnabled) ?? true,
    voiceEnabled: booleanValue(source.voiceEnabled) ?? true,
    chatDelayMs: numberValue(source.chatDelayMs) ?? 1200,
    voiceDelayMs: numberValue(source.voiceDelayMs) ?? 500,
    cooldownMs: numberValue(source.cooldownMs) ?? 3000,
    maxPerTurn: numberValue(source.maxPerTurn) ?? 5,
    piggybackEnabled: booleanValue(source.piggybackEnabled) ?? true,
    pipelineGenerationEnabled: booleanValue(source.pipelineGenerationEnabled) ?? true,
    modelSource:
      rawModelSource === 'default'
        ? 'system'
        : ((rawModelSource as RuntimeModelSourceIR) ?? 'system'),
    modelId: stringValue(source.modelId),
    tenantModelId: stringValue(source.tenantModelId),
    promptRef: asRecord(source.promptRef) as RuntimeFillerConfigIR['promptRef'],
  };
}

export function mapProjectRuntimeConfigDocumentToIR(input: unknown): ProjectRuntimeConfigIR {
  const doc = asRecord(input) ?? {};
  const extraction = asRecord(doc.extraction);
  const multiIntent = asRecord(doc.multi_intent);
  const inference = asRecord(doc.inference);
  const conversion = asRecord(doc.conversion);

  const lookupTables = Array.isArray(doc.lookup_tables) ? doc.lookup_tables : [];
  const compaction = mapCompactionConfig(doc.compaction);
  const pipeline = mapPipelineConfig(doc.pipeline);
  const filler = mapFillerConfig(doc.filler);

  return {
    extraction_strategy:
      (stringValue(extraction?.strategy) as ProjectRuntimeConfigIR['extraction_strategy']) ??
      'auto',
    nlu_provider:
      (stringValue(extraction?.nlu_provider) as ProjectRuntimeConfigIR['nlu_provider']) ??
      'standard',
    advanced_sidecar_url: stringValue(extraction?.advanced_sidecar_url),
    advanced_sidecar_timeout_ms: numberValue(extraction?.advanced_sidecar_timeout_ms),
    advanced_sidecar_circuit_breaker_threshold: numberValue(
      extraction?.advanced_sidecar_circuit_breaker_threshold,
    ),
    correction_detection:
      (stringValue(
        extraction?.correction_detection,
      ) as ProjectRuntimeConfigIR['correction_detection']) ?? 'ml',
    sidecar_timeout_ms: numberValue(extraction?.sidecar_timeout_ms),
    sidecar_circuit_breaker_threshold: numberValue(extraction?.sidecar_circuit_breaker_threshold),
    multi_intent: {
      enabled: booleanValue(multiIntent?.enabled) ?? true,
      strategy:
        (stringValue(
          multiIntent?.strategy,
        ) as ProjectRuntimeConfigIR['multi_intent']['strategy']) ?? 'primary_queue',
      max_intents: numberValue(multiIntent?.max_intents) ?? 3,
      confidence_threshold: numberValue(multiIntent?.confidence_threshold) ?? 0.6,
      queue_max_age_ms: numberValue(multiIntent?.queue_max_age_ms) ?? 600_000,
    },
    inference: {
      confidence: numberValue(inference?.confidence) ?? 0.8,
      confirm: booleanValue(inference?.confirm) ?? true,
      model_tier: stringValue(inference?.model_tier) ?? 'fast',
      max_fields_per_pass: numberValue(inference?.max_fields_per_pass) ?? 3,
    },
    conversion: {
      currency_mode: (stringValue(conversion?.currency_mode) as 'static' | 'live') ?? 'static',
      currency_api_url: stringValue(conversion?.currency_api_url),
    },
    lookup_tables: lookupTables.map((entry) => {
      const table = asRecord(entry) ?? {};
      return {
        name: stringValue(table.name) ?? '',
        source: (stringValue(table.source) as LookupTableIR['source']) ?? 'inline',
        values: stringArrayValue(table.values),
        table_name: stringValue(table.table_name),
        endpoint: stringValue(table.endpoint),
        field: stringValue(table.field),
        timeout_ms: numberValue(table.timeout_ms),
        case_sensitive: booleanValue(table.case_sensitive) ?? false,
        fuzzy_match: booleanValue(table.fuzzy_match) ?? false,
        fuzzy_threshold: numberValue(table.fuzzy_threshold) ?? 0.8,
      };
    }),
    ...(compaction ? { compaction } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(filler ? { filler } : {}),
  };
}
