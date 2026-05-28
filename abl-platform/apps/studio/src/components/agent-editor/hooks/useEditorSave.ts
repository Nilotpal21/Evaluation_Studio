/**
 * Editor Save Serialization Adapter
 *
 * Maps the fine-grained 17-section SectionDataMap used by the editor UI
 * back to the grouped serializer inputs expected by the existing ABL
 * serializers in `@/lib/abl-serializers`.
 *
 * Each serializer returns `SectionEdit[]` (section name + DSL content),
 * and this adapter knows which serializer(s) to call based on which
 * editor sections are dirty.
 */

import type { SectionEdit } from '../../../lib/abl-serializers';
import {
  serializeIdentityToABL,
  serializeExecutionToABL,
  serializeToolsToABL,
  serializeGatherToABL,
  serializeFlowToABL,
  serializeRulesToABL,
  serializeCoordinationToABL,
  serializeOnStartToABL,
  serializeErrorHandlingToABL,
  serializeCompletionToABL,
  serializeConversationBehaviorToABL,
  serializeBehaviorRefsToABL,
} from '../../../lib/abl-serializers';
import type { EditorSection, SectionDataMap } from '../types';

// =============================================================================
// DIRTY GROUP DETECTION
// =============================================================================

/** Sections that trigger rules serialization */
const RULES_SECTIONS: ReadonlySet<EditorSection> = new Set(['constraints', 'guardrails']);

/** Sections that trigger coordination serialization */
const COORDINATION_SECTIONS: ReadonlySet<EditorSection> = new Set([
  'handoffs',
  'delegates',
  'escalation',
]);

/**
 * Check whether any section in a given group is dirty.
 */
function hasDirtyIn(dirty: Set<EditorSection>, group: ReadonlySet<EditorSection>): boolean {
  for (const section of dirty) {
    if (group.has(section)) return true;
  }
  return false;
}

// =============================================================================
// MAIN ADAPTER
// =============================================================================

/**
 * Given the set of dirty editor sections and the full section data map,
 * produces the SectionEdit[] array that the existing editSections API expects.
 *
 * Maps fine-grained editor sections back to the grouped serializer inputs.
 */
export function serializeEditorSections(
  dirtySections: Set<EditorSection>,
  sections: SectionDataMap,
): SectionEdit[] {
  const edits: SectionEdit[] = [];

  // --- Definition: full DSL replacement ---
  if (dirtySections.has('definition')) {
    edits.push({ section: 'FULL', content: sections.definition });
    // When replacing the full DSL, no other section edits are needed
    return edits;
  }

  // --- Identity -> serializeIdentityToABL (GOAL/PERSONA/LIMITATIONS) ---
  if (dirtySections.has('identity')) {
    edits.push(...serializeIdentityToABL(sections.identity));
  }

  // --- Execution -> serializeExecutionToABL (EXECUTION block) ---
  if (dirtySections.has('execution')) {
    edits.push(...serializeExecutionToABL(sections.execution));
  }

  // --- Tools -> serializeToolsToABL ---
  if (dirtySections.has('tools')) {
    edits.push(...serializeToolsToABL(sections.tools));
  }

  // --- Gather -> serializeGatherToABL ---
  if (dirtySections.has('gather')) {
    edits.push(...serializeGatherToABL(sections.gather));
  }

  // --- Flow -> serializeFlowToABL ---
  if (dirtySections.has('flow')) {
    edits.push(...serializeFlowToABL(sections.flow));
  }

  // --- Behavior -> CONVERSATION + USE BEHAVIOR_PROFILE refs ---
  if (dirtySections.has('behavior')) {
    edits.push(...serializeConversationBehaviorToABL(sections.behavior.conversationBehavior));
    edits.push(
      ...serializeBehaviorRefsToABL(sections.behavior.profiles.map((profile) => profile.name)),
    );
  }

  // --- Constraints + Guardrails -> serializeRulesToABL ---
  if (hasDirtyIn(dirtySections, RULES_SECTIONS)) {
    edits.push(
      ...serializeRulesToABL({
        constraints: sections.constraints,
        guardrails: sections.guardrails,
      }),
    );
  }

  // --- Handoffs + Delegates + Escalation -> serializeCoordinationToABL ---
  if (hasDirtyIn(dirtySections, COORDINATION_SECTIONS)) {
    edits.push(
      ...serializeCoordinationToABL({
        handoffs: sections.handoffs,
        delegates: sections.delegates,
        escalation: sections.escalation,
      }),
    );
  }

  // --- Lifecycle sections -> serialize independently to avoid collateral rewrites ---
  if (dirtySections.has('onStart')) {
    edits.push(...serializeOnStartToABL(sections.onStart));
  }
  if (dirtySections.has('errorHandling')) {
    edits.push(...serializeErrorHandlingToABL(sections.errorHandling));
  }
  if (dirtySections.has('completion')) {
    edits.push(...serializeCompletionToABL(sections.completion));
  }

  return edits;
}
