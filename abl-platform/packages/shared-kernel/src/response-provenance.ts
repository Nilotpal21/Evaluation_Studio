export type ResponseProvenanceKind = 'scripted' | 'llm' | 'mixed';

export interface ResponseProvenance {
  schemaVersion: 1;
  kind: ResponseProvenanceKind;
  disclaimerRequired: boolean;
  usedLlmInternally: boolean;
}

export interface ResponseMessageMetadata extends Record<string, unknown> {
  isLlmGenerated: boolean;
  responseProvenance: ResponseProvenance;
}

export interface ResponseProvenanceAccumulator {
  hadLlmCall: boolean;
  customerVisibleLlmCall: boolean;
  internalOnlyLlmCall: boolean;
}

// Module-level static lookup tables — not runtime caches. No MAX_SIZE / TTL needed
// because content is fixed at module load time and never mutated.
//
// IMPORTANT: these are the DISCLOSURE-targeted sets. They drive the
// `ResponseMessageMetadata.responseProvenance` (kind / disclaimerRequired)
// surfaced to SDK customers on every assistant message and to Studio
// session-replay. Widening these sets silently changes the AI-disclosure
// contract — DO NOT add entries without explicit product / compliance
// sign-off. A broader taxonomy used for *cost attribution* (not user-
// facing disclosure) lives in `llm-trace-classifier.ts` and exports
// `classifyLlmTraceForCostAttribution`.
const INTERNAL_ONLY_PURPOSES = new Set(['entity_extraction', 'field_validation']);
const INTERNAL_ONLY_OPERATION_TYPES = new Set(['extraction', 'kb_classify', 'kb_classify_vocab']);
const INTERNAL_ONLY_RESPONSE_CONTRIBUTION = 'internal_only';
const CUSTOMER_VISIBLE_RESPONSE_CONTRIBUTION = 'customer_visible';
const IGNORED_RESPONSE_CONTRIBUTIONS = new Set(['none', 'simulated']);
const FALLBACK_MODEL_ID = 'fallback (no API key)';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function createResponseProvenanceAccumulator(): ResponseProvenanceAccumulator {
  return {
    hadLlmCall: false,
    customerVisibleLlmCall: false,
    internalOnlyLlmCall: false,
  };
}

export function extractLlmTraceMetrics(eventData: Record<string, unknown>): {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  model?: string;
  provider?: string;
} {
  const usage = asRecord(eventData.usage);
  const model = typeof eventData.model === 'string' ? eventData.model : undefined;
  const provider = typeof eventData.provider === 'string' ? eventData.provider : undefined;

  return {
    tokensIn:
      readNumber(eventData.tokensIn) ||
      readNumber(usage?.inputTokens) ||
      readNumber(usage?.promptTokens),
    tokensOut:
      readNumber(eventData.tokensOut) ||
      readNumber(usage?.outputTokens) ||
      readNumber(usage?.completionTokens),
    cost: readNumber(eventData.cost),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

export function classifyLlmTraceVisibility(
  eventData: Record<string, unknown>,
): 'ignored' | 'internal_only' | 'customer_visible' {
  if (eventData.simulated === true || eventData.model === FALLBACK_MODEL_ID) {
    return 'ignored';
  }

  const responseContribution =
    typeof eventData.responseContribution === 'string' ? eventData.responseContribution : undefined;
  if (responseContribution === INTERNAL_ONLY_RESPONSE_CONTRIBUTION) {
    return 'internal_only';
  }
  if (responseContribution === CUSTOMER_VISIBLE_RESPONSE_CONTRIBUTION) {
    return 'customer_visible';
  }
  if (responseContribution && IGNORED_RESPONSE_CONTRIBUTIONS.has(responseContribution)) {
    return 'ignored';
  }

  const purpose = typeof eventData.purpose === 'string' ? eventData.purpose : undefined;
  if (purpose && INTERNAL_ONLY_PURPOSES.has(purpose)) {
    return 'internal_only';
  }

  const operationType =
    typeof eventData.operationType === 'string' ? eventData.operationType : undefined;
  if (operationType && INTERNAL_ONLY_OPERATION_TYPES.has(operationType)) {
    return 'internal_only';
  }

  return 'customer_visible';
}

/**
 * Alias of {@link classifyLlmTraceVisibility}. This is the disclosure-targeted
 * classifier — used to decide whether `ResponseMessageMetadata.responseProvenance`
 * marks a response as `kind: 'llm'` vs `'scripted'` and whether
 * `disclaimerRequired` flips. For cost-rollup classification, use
 * `classifyLlmTraceForCostAttribution` from `llm-trace-classifier.ts` instead.
 */
export const classifyLlmTraceForDisclosure = classifyLlmTraceVisibility;

export function accumulateResponseProvenance(
  accumulator: ResponseProvenanceAccumulator,
  event: { type: string; data: Record<string, unknown> },
): void {
  if (event.type !== 'llm_call' || !event.data) {
    return;
  }

  const visibility = classifyLlmTraceVisibility(event.data);
  if (visibility === 'ignored') {
    return;
  }

  accumulator.hadLlmCall = true;
  if (visibility === 'customer_visible') {
    accumulator.customerVisibleLlmCall = true;
    return;
  }

  accumulator.internalOnlyLlmCall = true;
}

export function buildResponseMessageMetadata(
  accumulator: ResponseProvenanceAccumulator,
): ResponseMessageMetadata {
  const isLlmGenerated = accumulator.customerVisibleLlmCall;
  const kind: ResponseProvenanceKind = isLlmGenerated
    ? accumulator.internalOnlyLlmCall
      ? 'mixed'
      : 'llm'
    : 'scripted';

  return {
    isLlmGenerated,
    responseProvenance: {
      schemaVersion: 1,
      kind,
      disclaimerRequired: isLlmGenerated,
      usedLlmInternally: accumulator.hadLlmCall,
    },
  };
}
