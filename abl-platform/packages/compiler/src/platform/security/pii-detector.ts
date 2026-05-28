/**
 * PII Detection and Redaction Service
 *
 * Regex-based PII detection for speed. Built-in entity types:
 * email, phone, SSN, credit card, IPv4. The `core` recognizer pack in
 * pii-recognizer-registry.ts is the single source of truth for these
 * patterns; the four entry-point helpers in this file delegate to the
 * default registry.
 */

import {
  type PIIRecognizerRegistry,
  getDefaultPIIRecognizerRegistry,
} from './pii-recognizer-registry.js';

// =============================================================================
// TYPES
// =============================================================================

export interface PIIDetection {
  type: PIIType;
  start: number;
  end: number;
  /**
   * Safe detection preview for downstream consumers.
   * Never contains the matched raw substring.
   */
  value: string;
  /**
   * Detection confidence in [0, 1]. Defaulted to 1.0 by createSafePIIDetection
   * for legacy regex matches; advanced recognizers may attenuate this.
   */
  confidence: number;
  /**
   * Optional recognizer name (e.g. 'core-email', 'eu-iban'). Populated by
   * createSafePIIDetection when the recognizer threads its name through.
   */
  recognizer?: string;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  detections: PIIDetection[];
  redacted: string;
}

export type BuiltinPIIType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address';
export type PIIType = BuiltinPIIType | (string & {});

// =============================================================================
// REDACT LABELS
// =============================================================================

const REDACT_LABELS: Record<BuiltinPIIType, string> = {
  email: '[REDACTED_EMAIL]',
  ssn: '[REDACTED_SSN]',
  credit_card: '[REDACTED_CARD]',
  phone: '[REDACTED_PHONE]',
  ip_address: '[REDACTED_IP]',
};

export function getPIIRedactLabel(type: PIIType): string {
  return REDACT_LABELS[type as BuiltinPIIType] || buildCustomRedactLabel(type);
}

export function createSafePIIDetection(
  type: PIIType,
  start: number,
  end: number,
  options?: { confidence?: number; recognizer?: string },
): PIIDetection {
  return {
    type,
    start,
    end,
    value: getPIIRedactLabel(type),
    confidence: options?.confidence ?? 1.0,
    ...(options?.recognizer ? { recognizer: options.recognizer } : {}),
  };
}

// =============================================================================
// DETECTION
// =============================================================================

/**
 * Detect PII in text and return detection results with redacted version.
 * Falls back to the singleton default registry when no registry is supplied.
 */
export function detectPII(text: string, registry?: PIIRecognizerRegistry): PIIDetectionResult {
  const detections = (registry ?? getDefaultPIIRecognizerRegistry()).detectAll(text);

  detections.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  const filtered = removeOverlaps(detections);

  // Build redacted string
  let redacted = text;
  // Process in reverse order to preserve indices
  for (let i = filtered.length - 1; i >= 0; i--) {
    const det = filtered[i];
    redacted =
      redacted.substring(0, det.start) + getPIIRedactLabel(det.type) + redacted.substring(det.end);
  }

  return {
    hasPII: filtered.length > 0,
    detections: filtered,
    redacted,
  };
}

/**
 * Redact all PII from text, returning only the redacted string
 */
export function redactPII(text: string, registry?: PIIRecognizerRegistry): string {
  return detectPII(text, registry).redacted;
}

/**
 * Check if text contains PII (fast check, no redaction).
 * Falls back to the singleton default registry when none is provided.
 */
export function containsPII(text: string, registry?: PIIRecognizerRegistry): boolean {
  return (registry ?? getDefaultPIIRecognizerRegistry()).detectAll(text).length > 0;
}

// =============================================================================
// SELECTIVE REDACTION
// =============================================================================

/**
 * Selective PII result with audit fields for exempted vs redacted types.
 */
export interface SelectivePIIResult extends PIIDetectionResult {
  exemptedTypes: PIIType[];
  redactedTypes: PIIType[];
}

/**
 * Detect and selectively redact PII, allowing exemptions for specific types
 * and optional confidence thresholding.
 *
 * Always detects ALL types and returns them for audit trail (OWASP LLM02
 * compliance). The redaction step honors `exemptTypes` (audit-but-don't-redact)
 * AND `confidenceThreshold` (skip low-confidence detections entirely — they
 * are NOT redacted in the output text and NOT counted in `redactedTypes`).
 *
 * Note: exemptTypes is NOT passed to registry.detectAll — we detect ALL types
 * first, then split exempt/redact ourselves.
 *
 * @param text - Input text to scan
 * @param exemptTypes - PII types to detect but NOT redact
 * @param registry - Optional pluggable recognizer registry
 * @param options.confidenceThreshold - Drop detections with `confidence` below
 *   this floor from BOTH the redaction step and the redactedTypes/hasPII view.
 *   Detections still appear in `result.detections` for audit visibility, but
 *   they are NOT redacted in `result.redacted`. Default: no threshold.
 */
export function detectPIISelective(
  text: string,
  exemptTypes?: Set<PIIType>,
  registry?: PIIRecognizerRegistry,
  options?: { confidenceThreshold?: number },
): SelectivePIIResult {
  const allDetections = (registry ?? getDefaultPIIRecognizerRegistry()).detectAll(text);

  allDetections.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const filtered = removeOverlaps(allDetections);

  const exempt = exemptTypes ?? new Set<PIIType>();
  const threshold = options?.confidenceThreshold;
  const meetsThreshold = (d: PIIDetection): boolean =>
    typeof threshold !== 'number' || threshold <= 0 ? true : (d.confidence ?? 1.0) >= threshold;

  const toRedact = filtered.filter((d) => !exempt.has(d.type) && meetsThreshold(d));
  const exempted = filtered.filter((d) => exempt.has(d.type) && meetsThreshold(d));

  let redacted = text;
  for (let i = toRedact.length - 1; i >= 0; i--) {
    const det = toRedact[i];
    redacted =
      redacted.substring(0, det.start) + getPIIRedactLabel(det.type) + redacted.substring(det.end);
  }

  return {
    hasPII: filtered.length > 0,
    detections: filtered,
    redacted,
    exemptedTypes: [...new Set(exempted.map((d) => d.type))],
    redactedTypes: [...new Set(toRedact.map((d) => d.type))],
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Remove overlapping detections, keeping the earlier/longer match.
 * Exported so detectAllAsync can reuse it after merging sync + async results.
 */
export function removeOverlaps(detections: PIIDetection[]): PIIDetection[] {
  if (detections.length <= 1) return detections;

  const result: PIIDetection[] = [detections[0]];

  for (let i = 1; i < detections.length; i++) {
    const prev = result[result.length - 1];
    const curr = detections[i];

    // If current starts after previous ends, no overlap
    if (curr.start >= prev.end) {
      result.push(curr);
    }
    // Otherwise skip (overlap — keep the first one)
  }

  return result;
}

function buildCustomRedactLabel(type: string): string {
  const normalized = type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized.length > 0 ? `[REDACTED_${normalized}]` : '[REDACTED]';
}
