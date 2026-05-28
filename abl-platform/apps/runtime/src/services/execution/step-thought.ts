/**
 * Step Thought — human-readable summaries of flow step types.
 *
 * Used by trace events and debugging tools to describe what a step does
 * without requiring the consumer to understand IR structure.
 */

import type { FlowStep } from '@abl/compiler/platform/ir/schema.js';

/**
 * Determine the step type string for a flow step.
 * Returns a lowercase identifier used in trace events.
 */
export function getStepType(step: FlowStep): string {
  if (step.await_attachment) return 'await_attachment';
  if (step.reasoning_zone) return 'reasoning_zone';
  if (step.gather) return 'gather';
  if (step.clear) return 'clear';
  if (step.transform) return 'transform';
  if (step.call) return 'call';
  if (step.human_approval) return 'human_approval';
  if (step.check) return 'check';
  if (step.set) return 'set';
  if (step.respond) return 'respond';
  return 'unknown';
}

/**
 * Build a human-readable summary of what a flow step does.
 * Returns a concise description suitable for trace events and debugging.
 *
 * Prefix conventions:
 *  - GATHER → "Collecting: field1, field2"
 *  - SET    → "Setting: var1, var2"
 *  - CHECK  → "Evaluating: <condition>"
 *  - RESPOND→ "Sending response"  (no content leak)
 *  - TRANSFORM→ "Transforming data"
 *  - CALL   → "Calling: <toolName>"
 *  - CLEAR  → "Clearing: var1, var2"
 *  - unknown→ "Processing step: <name>"
 */
export function buildStepSummary(step: FlowStep): string {
  if (step.await_attachment) {
    return `Waiting for file upload: ${step.await_attachment.variable}`;
  }
  if (step.reasoning_zone) {
    return `Reasoning zone: ${step.name}`;
  }
  if (step.gather && step.gather.fields && step.gather.fields.length > 0) {
    const fieldNames = step.gather.fields.map((f) => f.name).join(', ');
    return `Collecting: ${fieldNames}`;
  }
  if (step.gather) {
    return `Collecting information`;
  }
  if (step.clear && step.clear.length > 0) {
    return `Clearing: ${step.clear.join(', ')}`;
  }
  if (step.transform) {
    return `Transforming data`;
  }
  if (step.call) {
    // Extract just the tool name from call expressions like "search_database(query, limit)"
    const toolNameMatch = step.call.match(/^(\w+)/);
    const toolName = toolNameMatch ? toolNameMatch[1] : step.call;
    return `Calling: ${toolName}`;
  }
  if (step.human_approval) {
    return `Human approval gate: ${step.name}`;
  }
  if (step.check) {
    return `Evaluating: ${step.check}`;
  }
  if (step.set && step.set.length > 0) {
    return `Setting: ${step.set.map((s) => s.variable).join(', ')}`;
  }
  if (step.respond) {
    // Never leak response content — just indicate a response is being sent
    return `Sending response`;
  }
  return `Processing step: ${step.name}`;
}
