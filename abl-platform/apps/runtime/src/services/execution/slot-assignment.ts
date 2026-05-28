/**
 * Slot Assignment — Maps entity observations to gather-field slots.
 *
 * Given an ObservationSet (extracted entities from the current turn) and
 * a list of SlotTargets (gather fields that reference entities), this
 * module determines:
 *
 *   Case C — 1 unique value  → direct assignment
 *   Case B — N values, 1 slot → clarification needed (user must choose)
 *   Case A — N values, M>1 slots → disambiguation needed (LLM assigns)
 *   Case D — 0 slots for entity → nothing to do
 *
 * All functions are pure — no side effects or mutations.
 */

import type { ObservationSet } from './entity-observations.js';
import { getObservationsForEntity } from './entity-observations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A gather field that should be populated from an entity reference. */
export interface SlotTarget {
  fieldName: string;
  entityRef: string;
  entityType: string;
  prompt: string;
}

/** A slot where the user must choose between multiple candidates. */
export interface ClarificationNeeded {
  fieldName: string;
  entityRef: string;
  candidates: unknown[];
  prompt: string;
}

/** An entity with multiple values that must be distributed across multiple slots by the LLM. */
export interface DisambiguationNeeded {
  entityName: string;
  entityType: string;
  values: unknown[];
  targetFields: Array<{ fieldName: string; prompt: string }>;
}

/** The result of attempting to assign observations to slots. */
export interface SlotAssignmentResult {
  assigned: Record<string, unknown>;
  needsClarification: ClarificationNeeded[];
  needsDisambiguation: DisambiguationNeeded[];
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Deduplicate values using JSON.stringify-based equality.
 * Preserves insertion order.
 */
function deduplicateValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const v of values) {
    const key = JSON.stringify(v);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(v);
    }
  }
  return result;
}

/**
 * Assign entity observations to gather-field slots.
 *
 * Groups slots by entityRef, then for each group:
 * - Filters out intrinsicValid===false observations
 * - Deduplicates values
 * - Applies Case C / B / A logic based on value count vs slot count
 */
export function assignObservationsToSlots(
  observations: ObservationSet,
  slots: SlotTarget[],
): SlotAssignmentResult {
  const assigned: Record<string, unknown> = {};
  const needsClarification: ClarificationNeeded[] = [];
  const needsDisambiguation: DisambiguationNeeded[] = [];

  // Case D: no slots → empty result
  if (slots.length === 0) {
    return { assigned, needsClarification, needsDisambiguation };
  }

  // Group slots by entityRef
  const slotsByRef = new Map<string, SlotTarget[]>();
  for (const slot of slots) {
    const group = slotsByRef.get(slot.entityRef) ?? [];
    group.push(slot);
    slotsByRef.set(slot.entityRef, group);
  }

  for (const [entityRef, groupSlots] of slotsByRef) {
    // Get observations for this entity, excluding intrinsicValid===false
    const allObs = getObservationsForEntity(observations, entityRef);
    const validObs = allObs.filter((obs) => obs.intrinsicValid !== false);

    // Deduplicate values
    const uniqueValues = deduplicateValues(validObs.map((obs) => obs.value));

    if (uniqueValues.length === 0) {
      // No valid observations for this entity — skip
      continue;
    }

    if (uniqueValues.length === 1) {
      // Case C: 1 unique value → assign to first slot
      assigned[groupSlots[0].fieldName] = uniqueValues[0];
    } else if (groupSlots.length === 1) {
      // Case B: N values, 1 slot → clarification needed
      needsClarification.push({
        fieldName: groupSlots[0].fieldName,
        entityRef,
        candidates: uniqueValues,
        prompt: groupSlots[0].prompt,
      });
    } else {
      // Case A: N values, M>1 slots → disambiguation needed
      needsDisambiguation.push({
        entityName: entityRef,
        entityType: groupSlots[0].entityType,
        values: uniqueValues,
        targetFields: groupSlots.map((s) => ({
          fieldName: s.fieldName,
          prompt: s.prompt,
        })),
      });
    }
  }

  return { assigned, needsClarification, needsDisambiguation };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build a disambiguation prompt for the LLM to assign entity values to fields.
 *
 * The prompt includes the user message, extracted values, and target fields
 * with their prompts, asking the LLM to respond with a JSON mapping.
 */
export function buildDisambiguationPrompt(
  userMessage: string,
  disambiguation: DisambiguationNeeded,
): string {
  const valueList = disambiguation.values.map((v) => String(v)).join(', ');
  const fieldLines = disambiguation.targetFields
    .map((f) => `- ${f.fieldName}: "${f.prompt}"`)
    .join('\n');

  return [
    `Given the user message: "${userMessage}"`,
    `Extracted ${disambiguation.entityType} values: ${valueList}`,
    '',
    'Assign each value to one of these fields:',
    fieldLines,
    '',
    'Respond with a JSON object mapping field names to values.',
  ].join('\n');
}

/**
 * Build a clarification message asking the user to choose between candidates.
 *
 * Uses the field's prompt as the question and lists the candidate values.
 */
export function buildClarificationMessage(clarification: ClarificationNeeded): string {
  const valueList = clarification.candidates.map((v) => String(v)).join(' and ');
  return `I found ${valueList}. ${clarification.prompt}`;
}
