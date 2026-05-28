import type {
  GuardrailAction,
  GuardrailActionType,
  GuardrailKind,
  GuardrailTier,
  SeverityLevel,
} from '../ir/schema.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';
import { ACTION_PRECEDENCE } from './constants.js';

export interface GuardrailContext {
  toolName?: string;
  toolParameters?: Record<string, unknown>;
  toolResult?: unknown;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  sourceAgent?: string;
  targetAgent?: string;
  handoffContext?: string;
  handoffReason?: string;
  retrievedDocuments?: Array<{ content: string; source: string }>;
  agentGoal?: string;
  recentMessages?: Array<{ role: string; content: string }>;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
}

export interface GuardrailViolation {
  name: string;
  kind: GuardrailKind;
  tier: GuardrailTier;
  action: GuardrailActionType;
  /**
   * Full resolved `GuardrailAction` object (with redactMode, fixStrategy, etc.).
   * Populated by Tier evaluators via the shared severity resolver.
   * The action applier prefers this over the default action pulled from
   * `actionContexts`, so severity-specific action payloads are honored.
   */
  resolvedAction?: GuardrailAction;
  severity: SeverityLevel;
  score?: number;
  threshold?: number;
  category?: string;
  label?: string;
  message: string;
  explanation?: string;
  priority: number;
  latencyMs: number;
  provider?: string;
  /** Forwarded from `Guardrail.presetKey` for trace-event correlation. */
  presetKey?: string;
}

export interface GuardrailPipelineResult {
  passed: boolean;
  violations: GuardrailViolation[];
  primaryViolation?: GuardrailViolation;
  modifiedContent?: string;
  warnings: GuardrailViolation[];
  metrics: PipelineMetrics;
}

export interface PipelineMetrics {
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: number;
  totalLatencyMs: number;
  tier1LatencyMs: number;
  tier2LatencyMs: number;
  tier3LatencyMs: number;
  compoundFPREstimate: number;
  costUsd: number;
  cacheHits: number;
  cacheMisses: number;
  policyVersion: number;
}

const TERMINAL_ACTIONS = new Set<GuardrailActionType>(['block', 'escalate', 'reask']);

export function isTerminalAction(action: GuardrailActionType): boolean {
  return TERMINAL_ACTIONS.has(action);
}

export function createEmptyPipelineResult(): GuardrailPipelineResult {
  return {
    passed: true,
    violations: [],
    warnings: [],
    metrics: {
      totalChecks: 0,
      passed: 0,
      failed: 0,
      warnings: 0,
      totalLatencyMs: 0,
      tier1LatencyMs: 0,
      tier2LatencyMs: 0,
      tier3LatencyMs: 0,
      compoundFPREstimate: 0,
      costUsd: 0,
      cacheHits: 0,
      cacheMisses: 0,
      policyVersion: 0,
    },
  };
}

export function addViolation(result: GuardrailPipelineResult, violation: GuardrailViolation): void {
  if (violation.action === 'warn') {
    result.warnings.push(violation);
    result.metrics.warnings++;
  } else {
    result.violations.push(violation);
    result.metrics.failed++;
    if (isTerminalAction(violation.action)) {
      result.passed = false;
    }
    // Primary = highest ACTION_PRECEDENCE; tiebreak by lowest priority number
    if (!result.primaryViolation) {
      result.primaryViolation = violation;
    } else {
      const currentPrec = ACTION_PRECEDENCE[result.primaryViolation.action] ?? 0;
      const newPrec = ACTION_PRECEDENCE[violation.action] ?? 0;
      if (
        newPrec > currentPrec ||
        (newPrec === currentPrec && violation.priority < result.primaryViolation.priority)
      ) {
        result.primaryViolation = violation;
      }
    }
  }
}
