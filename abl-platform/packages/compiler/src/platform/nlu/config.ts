/**
 * NLU Configuration
 *
 * Typed, validated, environment-aware NLU configuration.
 * Merges: environment defaults → env vars → ABL spec → overrides.
 *
 * NO Zod — uses plain TypeScript validation.
 */

import type { Environment } from '../core/types.js';
import type { NLUIRConfig } from './types.js';

// =============================================================================
// NLU CONFIG
// =============================================================================

export interface NLUConfig {
  fastModel: string;
  balancedModel?: string;
  confidenceThreshold: number;
  enableFallbacks: boolean;
  environment: Environment;
  cache: {
    enabled: boolean;
    ttlMs: number;
    intentTtlMs: number;
    entityTtlMs: number;
  };
  piiRedaction: {
    enabled: boolean;
    redactInput: boolean;
    redactOutput: boolean;
  };
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeoutMs: number;
  };
  audit: {
    enabled: boolean;
    logPredictions: boolean;
  };
  rateLimiting: {
    enabled: boolean;
    maxCallsPerMinute: number;
  };
}

// =============================================================================
// ENVIRONMENT DEFAULTS
// =============================================================================

const BASE_DEFAULTS: NLUConfig = {
  fastModel: 'default',
  confidenceThreshold: 0.7,
  enableFallbacks: true,
  environment: 'dev',
  cache: { enabled: false, ttlMs: 600_000, intentTtlMs: 600_000, entityTtlMs: 120_000 },
  piiRedaction: { enabled: false, redactInput: true, redactOutput: false },
  circuitBreaker: { enabled: true, failureThreshold: 5, resetTimeoutMs: 30_000 },
  audit: { enabled: false, logPredictions: false },
  rateLimiting: { enabled: false, maxCallsPerMinute: 1000 },
};

const ENVIRONMENT_OVERRIDES: Record<Environment, Partial<NLUConfig>> = {
  dev: {
    cache: { enabled: false, ttlMs: 600_000, intentTtlMs: 600_000, entityTtlMs: 120_000 },
    piiRedaction: { enabled: false, redactInput: true, redactOutput: false },
    audit: { enabled: false, logPredictions: false },
    circuitBreaker: { enabled: false, failureThreshold: 5, resetTimeoutMs: 30_000 },
  },
  staging: {
    cache: { enabled: true, ttlMs: 600_000, intentTtlMs: 600_000, entityTtlMs: 120_000 },
    piiRedaction: { enabled: true, redactInput: true, redactOutput: false },
    audit: { enabled: true, logPredictions: false },
  },
  production: {
    cache: { enabled: true, ttlMs: 600_000, intentTtlMs: 600_000, entityTtlMs: 120_000 },
    piiRedaction: { enabled: true, redactInput: true, redactOutput: true },
    audit: { enabled: true, logPredictions: true },
  },
};

// =============================================================================
// ENV VAR MAPPING
// =============================================================================

function applyEnvVars(config: NLUConfig, envVars: Record<string, string>): NLUConfig {
  const result = { ...config };

  if (envVars.NLU_FAST_MODEL) result.fastModel = envVars.NLU_FAST_MODEL;
  if (envVars.NLU_BALANCED_MODEL) result.balancedModel = envVars.NLU_BALANCED_MODEL;
  if (envVars.NLU_CONFIDENCE_THRESHOLD) {
    const v = parseFloat(envVars.NLU_CONFIDENCE_THRESHOLD);
    if (!isNaN(v)) result.confidenceThreshold = v;
  }

  if (envVars.NLU_CACHE_ENABLED !== undefined) {
    result.cache = { ...result.cache, enabled: envVars.NLU_CACHE_ENABLED === 'true' };
  }
  if (envVars.NLU_CACHE_TTL_MS) {
    const v = parseInt(envVars.NLU_CACHE_TTL_MS, 10);
    if (!isNaN(v)) result.cache = { ...result.cache, ttlMs: v };
  }
  if (envVars.NLU_PII_REDACTION_ENABLED !== undefined) {
    result.piiRedaction = {
      ...result.piiRedaction,
      enabled: envVars.NLU_PII_REDACTION_ENABLED === 'true',
    };
  }
  if (envVars.NLU_CIRCUIT_BREAKER_ENABLED !== undefined) {
    result.circuitBreaker = {
      ...result.circuitBreaker,
      enabled: envVars.NLU_CIRCUIT_BREAKER_ENABLED === 'true',
    };
  }
  if (envVars.NLU_AUDIT_ENABLED !== undefined) {
    result.audit = { ...result.audit, enabled: envVars.NLU_AUDIT_ENABLED === 'true' };
  }
  if (envVars.NLU_RATE_LIMIT_PER_MINUTE) {
    const v = parseInt(envVars.NLU_RATE_LIMIT_PER_MINUTE, 10);
    if (!isNaN(v)) result.rateLimiting = { ...result.rateLimiting, maxCallsPerMinute: v };
  }

  return result;
}

// =============================================================================
// ABL CONFIG MAPPING
// =============================================================================

function applyABLConfig(config: NLUConfig, ablConfig: NLUIRConfig): NLUConfig {
  const result = { ...config };

  if (ablConfig.models?.fast) result.fastModel = ablConfig.models.fast;
  if (ablConfig.models?.balanced) result.balancedModel = ablConfig.models.balanced;
  if (ablConfig.evaluation?.confidenceThreshold !== undefined) {
    result.confidenceThreshold = ablConfig.evaluation.confidenceThreshold;
  }

  return result;
}

// =============================================================================
// BUILDER
// =============================================================================

export function buildNLUConfig(options: {
  environment: Environment;
  envVars?: Record<string, string>;
  ablConfig?: NLUIRConfig;
  overrides?: Partial<NLUConfig>;
}): NLUConfig {
  // 1. Start with base defaults
  let config: NLUConfig = { ...BASE_DEFAULTS, environment: options.environment };

  // 2. Apply environment-specific defaults
  const envOverrides = ENVIRONMENT_OVERRIDES[options.environment];
  if (envOverrides) {
    config = deepMerge(config, envOverrides);
  }

  // 3. Apply environment variables
  if (options.envVars) {
    config = applyEnvVars(config, options.envVars);
  }

  // 4. Apply ABL-declared config
  if (options.ablConfig) {
    config = applyABLConfig(config, options.ablConfig);
  }

  // 5. Apply manual overrides (highest priority)
  if (options.overrides) {
    config = deepMerge(config, options.overrides);
  }

  return config;
}

// =============================================================================
// VALIDATION
// =============================================================================

export function validateNLUConfig(config: NLUConfig): string[] {
  const errors: string[] = [];

  if (!config.fastModel) {
    errors.push('fastModel is required');
  }
  if (config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    errors.push('confidenceThreshold must be between 0 and 1');
  }
  if (config.cache.ttlMs < 0) {
    errors.push('cache.ttlMs must be non-negative');
  }
  if (config.circuitBreaker.failureThreshold < 1) {
    errors.push('circuitBreaker.failureThreshold must be at least 1');
  }
  if (config.circuitBreaker.resetTimeoutMs < 0) {
    errors.push('circuitBreaker.resetTimeoutMs must be non-negative');
  }
  if (config.rateLimiting.maxCallsPerMinute < 1) {
    errors.push('rateLimiting.maxCallsPerMinute must be at least 1');
  }

  return errors;
}

// =============================================================================
// HELPERS
// =============================================================================

function deepMerge(base: NLUConfig, overrides: Partial<NLUConfig>): NLUConfig {
  const result = { ...base };

  for (const key of Object.keys(overrides) as Array<keyof NLUConfig>) {
    const override = overrides[key];
    const baseVal = base[key];

    if (
      override !== undefined &&
      typeof override === 'object' &&
      override !== null &&
      !Array.isArray(override) &&
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      (result as Record<string, unknown>)[key] = {
        ...(baseVal as object),
        ...(override as object),
      };
    } else if (override !== undefined) {
      (result as Record<string, unknown>)[key] = override;
    }
  }

  return result;
}
