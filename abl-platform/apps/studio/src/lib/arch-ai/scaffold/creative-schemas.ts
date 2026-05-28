/**
 * Zod schemas for the structured-output LLM call.
 *
 * One builder function per archetype; each takes the skeleton's computed
 * structure and returns the exact Zod schema the LLM must match. Passed
 * to AI SDK's `generateObject({ schema, prompt })`.
 *
 * Schemas define the creative slots only — all structural fields (keyword,
 * TO: names, RETURN flags) are emitted by the scaffold, not the LLM.
 */

import { z } from 'zod';
import type { AblSkeleton, HandoffEntry } from './types';

const GOAL = z
  .string()
  .min(20, 'GOAL must be at least 20 characters.')
  .max(500, 'GOAL must be at most 500 characters.')
  .describe(
    "One sentence describing the agent's high-level purpose. Start with an action verb (Route, Classify, Handle, etc.).",
  );

const PERSONA = z
  .string()
  .min(100, 'PERSONA must be at least 100 characters.')
  .max(2000, 'PERSONA must be at most 2000 characters.')
  .describe(
    'Multi-sentence persona. Describe voice, tone, decision-making boundaries, and how the agent handles ambiguity. Reference the domain.',
  );

function buildGatherShape(skeleton: AblSkeleton): Record<string, z.ZodTypeAny> | null {
  if (skeleton.gatherFields.length === 0) {
    return null;
  }

  const gatherShape: Record<string, z.ZodTypeAny> = {};
  for (const field of skeleton.gatherFields) {
    gatherShape[`${field.name}.ask`] = z
      .string()
      .min(20, `GATHER ask for "${field.name}" must be at least 20 characters.`)
      .max(300, `GATHER ask for "${field.name}" must be at most 300 characters.`)
      .describe(
        `Polite first-person question asking the user for "${field.name}". End with a "?". Do not use templates.`,
      );
  }
  return gatherShape;
}

/**
 * Build the supervisor archetype schema. Emits one WHEN slot per non-catch-all
 * handoff; the catch-all is code-owned and not a slot.
 */
export function buildSupervisorSchema(skeleton: AblSkeleton): z.ZodTypeAny {
  const handoffShape: Record<string, z.ZodTypeAny> = {};

  for (let i = 0; i < skeleton.handoffs.length; i++) {
    const entry = skeleton.handoffs[i];
    if (entry.whenSlot === null) continue; // catch-all — literal WHEN

    handoffShape[`${i}.when`] = z
      .string()
      .min(10, 'HANDOFF WHEN must be at least 10 characters.')
      .max(200, 'HANDOFF WHEN must be at most 200 characters.')
      .describe(
        `Runtime-actionable WHEN expression for routing to "${entry.to}". Prefer intent.category == "..." for supervisor intent routing. Do not invent state variables or write plain English.`,
      );
  }

  const shape: Record<string, z.ZodTypeAny> = {
    goal: GOAL,
    persona: PERSONA,
    handoff: z.object(handoffShape).strict(),
  };
  const gatherShape = buildGatherShape(skeleton);
  if (gatherShape) {
    shape.gather = z.object(gatherShape).strict();
  }

  return z.object(shape).strict();
}

/** Internal helper — build the handoff group from non-catch-all entries. */
function buildHandoffGroupShape(
  handoffs: ReadonlyArray<HandoffEntry>,
): Record<string, z.ZodTypeAny> | null {
  const handoffShape: Record<string, z.ZodTypeAny> = {};
  for (let i = 0; i < handoffs.length; i++) {
    const entry = handoffs[i];
    if (entry.whenSlot === null) continue; // catch-all — literal WHEN, not a slot
    handoffShape[`${i}.when`] = z
      .string()
      .min(10, 'HANDOFF WHEN must be at least 10 characters.')
      .max(200, 'HANDOFF WHEN must be at most 200 characters.')
      .describe(
        `Runtime-actionable WHEN expression for routing to "${entry.to}". Prefer intent.category == "..." for intent routing, or a boolean expression over declared state. Do not write plain English.`,
      );
  }
  return Object.keys(handoffShape).length > 0 ? handoffShape : null;
}

function toGroupSubKey(slotPath: string, group: 'complete'): string {
  const prefix = `${group}.`;
  return slotPath.startsWith(prefix) ? slotPath.slice(prefix.length) : slotPath;
}

/**
 * Build the specialist archetype schema. Emits goal, persona, and optional
 * groups (gather, complete, handoff) based on the skeleton's declared slots.
 *
 * A single root ZodObject is returned — never ZodIntersection — because some
 * LLM providers (e.g. OpenAI structured output) reject JSON Schemas that
 * don't have a literal `type: "object"` at the root. Intersections convert
 * to `allOf` which fails that check.
 */
export function buildSpecialistSchema(skeleton: AblSkeleton): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {
    goal: GOAL,
    persona: PERSONA,
  };

  if (skeleton.gatherFields.length > 0) {
    shape.gather = z.object(buildGatherShape(skeleton) ?? {}).strict();
  }

  if (skeleton.completeSlots.length > 0) {
    const completeShape: Record<string, z.ZodTypeAny> = {};
    const declaredNames = skeleton.gatherFields.map((f) => f.name).join(', ') || '(none)';
    for (const pair of skeleton.completeSlots) {
      if (pair.whenSlot !== null) {
        completeShape[toGroupSubKey(pair.whenSlot, 'complete')] = z
          .string()
          .min(10, `COMPLETE "${pair.whenSlot}" must be at least 10 characters.`)
          .max(200, `COMPLETE "${pair.whenSlot}" must be at most 200 characters.`)
          .describe(
            `Expression evaluating to true when the agent has collected enough to return. Reference ONLY the declared GATHER field names: ${declaredNames}. Example: "order_number != null".`,
          );
      }
      if (pair.respondSlot !== null) {
        completeShape[toGroupSubKey(pair.respondSlot, 'complete')] = z
          .string()
          .max(300, `COMPLETE "${pair.respondSlot}" must be at most 300 characters.`)
          .describe(
            'Optional completion message shown when this condition matches. Use an empty string for silent completion.',
          );
      }
    }
    if (Object.keys(completeShape).length > 0) {
      shape.complete = z.object(completeShape).strict();
    }
  }

  // Pipeline stages (and any other specialist-shaped archetype with outgoing
  // handoffs) include a handoff group alongside gather/complete. Build into
  // the same root object — no intersection.
  const handoffShape = buildHandoffGroupShape(skeleton.handoffs);
  if (handoffShape) {
    shape.handoff = z.object(handoffShape).strict();
  }

  return z.object(shape).strict();
}
