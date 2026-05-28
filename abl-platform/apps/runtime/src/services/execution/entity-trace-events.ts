/**
 * Entity Lifecycle Trace Event Builders
 *
 * Pure builder functions that create trace events for the entity extraction
 * pipeline. Each returns { type, data } matching the runtime's existing
 * trace event shape (emitted via onTraceEvent callback).
 *
 * Optional parameters are only included in `data` when defined — no
 * `span: undefined` pollution.
 */

/** Shape of all entity trace events — matches the runtime's existing trace contract. */
export interface EntityTraceEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * An entity value was observed in user input by the extraction pipeline.
 * When `sensitive` is true, the value is replaced with a masked redaction
 * to prevent PII from appearing in trace logs.
 */
export function traceEntityObservation(
  agentName: string,
  entityName: string,
  entityType: string,
  value: unknown,
  confidence: number,
  span?: { start: number; end: number },
  sensitive?: boolean,
  maskFn?: (value: unknown, entityType: string) => string,
): EntityTraceEvent {
  const traceValue = sensitive && maskFn ? maskFn(value, entityType) : value;
  const data: Record<string, unknown> = {
    agentName,
    entityName,
    entityType,
    value: traceValue,
    confidence,
  };
  if (sensitive) {
    data.sensitive = true;
  }
  if (span !== undefined) {
    data.span = span;
  }
  return { type: 'entity_observation', data };
}

/**
 * An entity value was checked against its intrinsic type validation (e.g. email format).
 * When `sensitive` is true, the value is masked in trace output.
 */
export function traceIntrinsicValidation(
  agentName: string,
  entityName: string,
  entityType: string,
  value: unknown,
  valid: boolean,
  error?: string,
  sensitive?: boolean,
  maskFn?: (value: unknown, entityType: string) => string,
): EntityTraceEvent {
  const traceValue = sensitive && maskFn ? maskFn(value, entityType) : value;
  const data: Record<string, unknown> = {
    agentName,
    entityName,
    entityType,
    value: traceValue,
    valid,
  };
  if (sensitive) {
    data.sensitive = true;
  }
  if (error !== undefined) {
    data.error = error;
  }
  return { type: 'entity_validation_intrinsic', data };
}

/**
 * An entity value was assigned to a gather field slot.
 */
export function traceSlotAssignment(
  agentName: string,
  fieldName: string,
  entityRef: string,
  value: unknown,
  method: 'direct' | 'disambiguation' | 'clarification',
): EntityTraceEvent {
  return {
    type: 'entity_slot_assignment',
    data: { agentName, fieldName, entityRef, value, method },
  };
}

/**
 * Clarification was requested for a slot — multiple candidates exist.
 */
export function traceSlotClarification(
  agentName: string,
  fieldName: string,
  entityRef: string,
  candidates: unknown[],
): EntityTraceEvent {
  return {
    type: 'entity_slot_clarification',
    data: { agentName, fieldName, entityRef, candidates },
  };
}

/**
 * Disambiguation was triggered — multiple values of the same entity need
 * to be assigned to different target fields.
 */
export function traceSlotDisambiguation(
  agentName: string,
  entityName: string,
  values: unknown[],
  targetFields: string[],
): EntityTraceEvent {
  return {
    type: 'entity_slot_disambiguation',
    data: { agentName, entityName, values, targetFields },
  };
}

/**
 * A field value was checked against its business validation rule (e.g. age range).
 */
export function traceBusinessValidation(
  agentName: string,
  fieldName: string,
  value: unknown,
  valid: boolean,
  error?: string,
): EntityTraceEvent {
  const data: Record<string, unknown> = {
    agentName,
    fieldName,
    value,
    valid,
  };
  if (error !== undefined) {
    data.error = error;
  }
  return { type: 'entity_validation_business', data };
}

/**
 * A field value was committed (finalized) to the session data store.
 */
export function traceEntityCommitment(
  agentName: string,
  fieldName: string,
  value: unknown,
): EntityTraceEvent {
  return {
    type: 'entity_commitment',
    data: { agentName, fieldName, value },
  };
}
