/**
 * Canonical trace payload for gather-interrupt routing decisions.
 *
 * This shape is shared across runtime, channel adapters, audits, and
 * evaluation harnesses so gather-interrupt traces do not drift into
 * incompatible ad-hoc object literals.
 */

export const GATHER_INTERRUPT_DETECTION_MODES = ['lexical', 'pipeline'] as const;
export type GatherInterruptDetectionMode = (typeof GATHER_INTERRUPT_DETECTION_MODES)[number];

export const GATHER_INTERRUPT_LEXICAL_MATCH_TYPES = ['exact', 'normalized'] as const;
export type GatherInterruptLexicalMatchType = (typeof GATHER_INTERRUPT_LEXICAL_MATCH_TYPES)[number];

export const GATHER_INTERRUPT_POLICY_VALUES = ['never', 'when_unavailable', 'always'] as const;
export type GatherInterruptPolicyApplied = (typeof GATHER_INTERRUPT_POLICY_VALUES)[number];

export const GATHER_INTERRUPT_CANDIDATE_SURFACE_KINDS = [
  'digression',
  'sub_intent',
  'parent_supervisor_route',
] as const;
export type GatherInterruptCandidateSurfaceKind =
  (typeof GATHER_INTERRUPT_CANDIDATE_SURFACE_KINDS)[number];

export interface GatherInterruptCandidateSurface {
  kind: GatherInterruptCandidateSurfaceKind;
  size: number;
  candidates: string[];
}

export interface GatherInterruptTrace {
  detectionMode: GatherInterruptDetectionMode;
  candidateSurface: GatherInterruptCandidateSurface;
  lexicalMatchType?: GatherInterruptLexicalMatchType;
  policyApplied?: GatherInterruptPolicyApplied;
  classifierConfidence?: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFiniteCandidateSurface(value: unknown): value is GatherInterruptCandidateSurface {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    !GATHER_INTERRUPT_CANDIDATE_SURFACE_KINDS.includes(
      record.kind as GatherInterruptCandidateSurfaceKind,
    )
  ) {
    return false;
  }

  if (!isStringArray(record.candidates)) {
    return false;
  }

  return (
    typeof record.size === 'number' &&
    Number.isInteger(record.size) &&
    record.size >= 0 &&
    record.size === record.candidates.length
  );
}

export function isGatherInterruptTrace(value: unknown): value is GatherInterruptTrace {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    !GATHER_INTERRUPT_DETECTION_MODES.includes(record.detectionMode as GatherInterruptDetectionMode)
  ) {
    return false;
  }

  if (!isFiniteCandidateSurface(record.candidateSurface)) {
    return false;
  }

  if (
    record.lexicalMatchType !== undefined &&
    !GATHER_INTERRUPT_LEXICAL_MATCH_TYPES.includes(
      record.lexicalMatchType as GatherInterruptLexicalMatchType,
    )
  ) {
    return false;
  }

  if (
    record.policyApplied !== undefined &&
    !GATHER_INTERRUPT_POLICY_VALUES.includes(record.policyApplied as GatherInterruptPolicyApplied)
  ) {
    return false;
  }

  return (
    record.classifierConfidence === undefined ||
    (typeof record.classifierConfidence === 'number' &&
      Number.isFinite(record.classifierConfidence) &&
      record.classifierConfidence >= 0 &&
      record.classifierConfidence <= 1)
  );
}
