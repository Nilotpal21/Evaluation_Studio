import type { SeverityLevel } from '../ir/schema.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';

export interface GuardrailEvalRequest {
  /** Text content to evaluate */
  content: string;

  /** Safety category to check */
  category: string;

  /** Optional conversation context (for contextual models) */
  context?: {
    systemPrompt?: string;
    recentMessages?: Array<{ role: string; content: string }>;
    retrievedDocuments?: Array<{ content: string; source: string }>;
    piiRecognizerRegistry?: PIIRecognizerRegistry;
    /** When set, only detections whose `type` is in this list trigger a violation. Empty/undefined = pass-through (all detections apply). */
    allowedEntityTypes?: string[];
  };

  /** Custom taxonomy/categories (for taxonomy-as-prompt models) */
  customTaxonomy?: string[];
}

export interface GuardrailEvalResult {
  /** Safety score: 0.0 (safe) to 1.0 (unsafe) */
  score: number;

  /** Severity classification */
  severity: SeverityLevel;

  /** Safety category evaluated */
  category: string;

  /** Specific violation label (e.g., "harassment", "self_harm") */
  label?: string;

  /** Model's reasoning/explanation */
  explanation?: string;

  /** Evaluation latency */
  latencyMs: number;

  /** Provider-specific raw response (for debugging) */
  raw?: unknown;
}

export interface GuardrailModelProvider {
  /** Provider identifier */
  readonly name: string;

  /** Evaluate content against a safety category */
  evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult>;

  /** Check provider health / availability */
  isAvailable(): Promise<boolean>;

  /** Estimated cost per evaluation in USD */
  readonly costPerEvalUsd: number;
}

export interface RuntimeProviderOverride {
  endpoint?: string;
  costPerEvalUsd?: number;
}

export interface ProviderRuntimeConfig {
  endpoint?: string;
  defaultCategory?: string;
  defaultThreshold?: number;
  costPerEvalUsd?: number;
  circuitBreaker?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    failMode?: 'open' | 'closed';
  };
  retry?: { maxRetries?: number; backoffBaseMs?: number };
}

export interface RuntimeOverrideableGuardrailProvider extends GuardrailModelProvider {
  withRuntimeOverride(override: RuntimeProviderOverride): GuardrailModelProvider;
}

export function isRuntimeOverrideableGuardrailProvider(
  provider: GuardrailModelProvider,
): provider is RuntimeOverrideableGuardrailProvider {
  return (
    typeof (provider as RuntimeOverrideableGuardrailProvider).withRuntimeOverride === 'function'
  );
}

/** Default severity thresholds for score-to-severity mapping */
const SEVERITY_THRESHOLDS = {
  low: 0.2,
  medium: 0.5,
  high: 0.7,
  critical: 0.9,
};

/** Convert a 0.0-1.0 safety score to a SeverityLevel */
export function scoreToSeverity(score: number): SeverityLevel {
  if (score >= SEVERITY_THRESHOLDS.critical) return 'critical';
  if (score >= SEVERITY_THRESHOLDS.high) return 'high';
  if (score >= SEVERITY_THRESHOLDS.medium) return 'medium';
  if (score >= SEVERITY_THRESHOLDS.low) return 'low';
  return 'safe';
}
