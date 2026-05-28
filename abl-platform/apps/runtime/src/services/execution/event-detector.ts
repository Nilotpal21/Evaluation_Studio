/**
 * Event resolution for the lifecycle event system.
 *
 * Event taxonomy (4 built-in patterns + named references):
 *   session:start, session:end
 *   agent:<name>:before, agent:<name>:after  (+ agent:*:before, agent:*:after)
 *   tool:<name>:after  (+ tool:*:after)
 *   entity:<field>:extracted, step:(enter|exit):<name>
 */

/** Legacy event names -> new lifecycle format (canonical source: @abl/compiler) */
export { LEGACY_EVENT_ALIASES, LIFECYCLE_PATTERNS } from '@abl/compiler';

/**
 * Resolve events after a tool call completes.
 * Returns the specific tool event + wildcard.
 */
export function resolveToolAfterEvents(toolName: string): string[] {
  return [`tool:${toolName}:after`, 'tool:*:after'];
}

/**
 * Resolve agent lifecycle events.
 * Fires for handoffs, delegates, and fan-out child agents.
 */
export function resolveAgentEvents(agentName: string, phase: 'before' | 'after'): string[] {
  return [`agent:${agentName}:${phase}`, `agent:*:${phase}`];
}

/**
 * Resolve entity extraction events. KEPT from original.
 */
export function detectEntityEvents(fieldNames: string[]): string[] {
  return fieldNames.map((name) => `entity:${name}:extracted`);
}

/**
 * Resolve step transition events. KEPT from original.
 */
export function detectStepEvents(stepName: string): string[] {
  return [`step:enter:${stepName}`];
}
