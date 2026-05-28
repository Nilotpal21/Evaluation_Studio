import { detectPII } from '../../security/pii-detector.js';
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '../provider.js';
import { scoreToSeverity } from '../provider.js';

/**
 * Built-in PII detection provider.
 *
 * Wraps the existing regex-based pii-detector as a GuardrailModelProvider.
 * Always available, zero cost, no external dependencies.
 *
 * - score 1.0 when PII is detected, 0.0 when clean
 * - label is the type of the first PII detection (email, ssn, phone, etc.)
 * - raw contains the full PIIDetectionResult for downstream inspection
 */

/** Upper bound for the entity-type allowlist Set (today ~37 PIIType values exist). */
const MAX_ALLOWED_ENTITY_TYPES = 100;

export class BuiltinPIIProvider implements GuardrailModelProvider {
  readonly name = 'builtin-pii';
  readonly costPerEvalUsd = 0;

  async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
    const start = performance.now();
    const result = detectPII(request.content, request.context?.piiRecognizerRegistry);
    const latencyMs = performance.now() - start;

    // Sensitive Data Block: filter detections to the rule's allowlisted entities.
    // CRITICAL: each detection's entity field is `type` (typed `PIIType`), NOT
    // `entityType`. Field-name confusion here would silently pass every detection
    // through the filter — the R-1 highest-risk failure mode.
    // Use Set for O(1) membership lookup; bounded by MAX_ALLOWED_ENTITY_TYPES.
    const allow = request.context?.allowedEntityTypes;
    const allowSet =
      allow && allow.length > 0 ? new Set(allow.slice(0, MAX_ALLOWED_ENTITY_TYPES)) : null;
    const filteredDetections = allowSet
      ? result.detections.filter((d) => allowSet.has(d.type))
      : result.detections;

    const score = filteredDetections.length > 0 ? 1.0 : 0.0;
    const firstDetection = filteredDetections[0];

    return {
      score,
      severity: scoreToSeverity(score),
      category: request.category,
      label: firstDetection?.type,
      explanation:
        filteredDetections.length > 0
          ? `Detected ${filteredDetections.length} PII instance(s): ${filteredDetections.map((d) => d.type).join(', ')}`
          : undefined,
      latencyMs,
      raw: result,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
