export const MODEL_ROUTING_TIERS = ['fast', 'balanced', 'powerful', 'voice', 'embedding'] as const;

export type ModelRoutingTier = (typeof MODEL_ROUTING_TIERS)[number];

export const TEXT_MODEL_ROUTING_TIERS = ['fast', 'balanced', 'powerful'] as const;

export type TextModelRoutingTier = (typeof TEXT_MODEL_ROUTING_TIERS)[number];

export const MODEL_ROUTING_OPERATIONS = [
  'extraction',
  'validation',
  'tool_selection',
  'response_gen',
  'summarization',
  'reasoning',
  'coordination',
  'realtime_voice',
] as const;

export type ModelRoutingOperation = (typeof MODEL_ROUTING_OPERATIONS)[number];

export const DEFAULT_OPERATION_TIERS = {
  extraction: 'fast',
  validation: 'fast',
  tool_selection: 'fast',
  response_gen: 'balanced',
  summarization: 'balanced',
  reasoning: 'powerful',
  coordination: 'powerful',
  realtime_voice: 'voice',
} as const satisfies Record<ModelRoutingOperation, ModelRoutingTier>;

export type OperationTierOverrides = Partial<Record<ModelRoutingOperation, ModelRoutingTier>>;

export type OperationTierOverrideValidationResult =
  | {
      ok: true;
      overrides: OperationTierOverrides;
    }
  | {
      ok: false;
      invalidOperations: string[];
      invalidTiers: string[];
      incompatiblePairs: Array<{ operation: string; tier: string }>;
    };

export function isModelRoutingTier(value: string): value is ModelRoutingTier {
  return (MODEL_ROUTING_TIERS as readonly string[]).includes(value);
}

export function isTextModelRoutingTier(value: string): value is TextModelRoutingTier {
  return (TEXT_MODEL_ROUTING_TIERS as readonly string[]).includes(value);
}

export function isModelRoutingOperation(value: string): value is ModelRoutingOperation {
  return (MODEL_ROUTING_OPERATIONS as readonly string[]).includes(value);
}

export function getDefaultOperationTier(operation: ModelRoutingOperation): ModelRoutingTier {
  return DEFAULT_OPERATION_TIERS[operation];
}

export function isOperationTierCompatible(
  operation: ModelRoutingOperation,
  tier: ModelRoutingTier,
): boolean {
  if (operation === 'realtime_voice') {
    return tier === 'voice';
  }
  if (tier === 'voice') {
    return false;
  }
  if (tier === 'embedding') {
    return false; // Embedding models cannot be assigned to routing operations
  }
  return true;
}

export function normalizeOperationTierOverrides(
  value: unknown,
): OperationTierOverrideValidationResult {
  if (value == null) {
    return { ok: true, overrides: {} };
  }

  const isRecord = typeof value === 'object' && !Array.isArray(value);
  if (!(value instanceof Map) && !isRecord) {
    return {
      ok: false,
      invalidOperations: [],
      invalidTiers: [String(value)],
      incompatiblePairs: [],
    };
  }

  const entries =
    value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>);

  const overrides: OperationTierOverrides = {};
  const invalidOperations: string[] = [];
  const invalidTiers: string[] = [];
  const incompatiblePairs: Array<{ operation: string; tier: string }> = [];

  for (const [rawOperation, rawTier] of entries) {
    const operation = String(rawOperation);
    const tier = String(rawTier);

    if (!isModelRoutingOperation(operation)) {
      invalidOperations.push(operation);
    }
    if (!isModelRoutingTier(tier)) {
      invalidTiers.push(tier);
    }
    if (
      isModelRoutingOperation(operation) &&
      isModelRoutingTier(tier) &&
      !isOperationTierCompatible(operation, tier)
    ) {
      incompatiblePairs.push({ operation, tier });
    }
    if (
      isModelRoutingOperation(operation) &&
      isModelRoutingTier(tier) &&
      isOperationTierCompatible(operation, tier)
    ) {
      overrides[operation] = tier;
    }
  }

  if (invalidOperations.length > 0 || invalidTiers.length > 0 || incompatiblePairs.length > 0) {
    return {
      ok: false,
      invalidOperations,
      invalidTiers,
      incompatiblePairs,
    };
  }

  return {
    ok: true,
    overrides,
  };
}

export function formatOperationTierOverrideError(
  validation: Exclude<OperationTierOverrideValidationResult, { ok: true }>,
): string {
  const parts: string[] = [];
  if (validation.invalidOperations.length > 0) {
    parts.push(`invalid operation(s): ${validation.invalidOperations.join(', ')}`);
  }
  if (validation.invalidTiers.length > 0) {
    parts.push(`invalid tier(s): ${validation.invalidTiers.join(', ')}`);
  }
  if (validation.incompatiblePairs.length > 0) {
    parts.push(
      `incompatible operation/tier pair(s): ${validation.incompatiblePairs
        .map(({ operation, tier }) => `${operation}=${tier}`)
        .join(', ')}`,
    );
  }
  return `Invalid operation-tier overrides (${parts.join('; ')}). Valid operations: ${MODEL_ROUTING_OPERATIONS.join(', ')}. Valid tiers: ${MODEL_ROUTING_TIERS.join(', ')}`;
}
